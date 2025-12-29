const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// DATA STORE
let players = {};      // Key: userId (Daimi ID)
let socketMap = {};    // Key: socket.id -> Value: userId (Əlaqələndirmə üçün)
let activeGames = {};  
let inviteCooldowns = {}; 
let playerStates = {}; // Key: userId

io.on('connection', (socket) => {
    // console.log('🔗 Yeni qoşulma:', socket.id);

    // 1. GİRİŞ (Login) - Artıq daimi ID qəbul edir
    socket.on('login', (userData) => {
        const userId = userData.id; // Client-dan gələn daimi ID
        
        // Socket ilə User ID-ni əlaqələndir
        socketMap[socket.id] = userId;

        // Əgər oyunçu server yaddaşında yoxdursa və ya server sönüb-yanıbsa:
        // Client-dan gələn balansı qəbul et (MVP üçün)
        if (!players[userId]) {
            players[userId] = {
                id: userId,
                name: userData.name,
                balance: userData.balance, // Yaddaşdan gələn balans
                avatar: userData.avatar,
                socketId: socket.id // Aktiv socket
            };
            playerStates[userId] = 'AVAILABLE';
        } else {
            // Oyunçu serverdə varsa, sadəcə socket-i yenilə
            players[userId].socketId = socket.id;
            players[userId].name = userData.name;
            players[userId].avatar = userData.avatar;
            // Balansı serverdəki daha çoxdursa onu saxla, yoxsa client-a inan (sync)
            // Bu sadə versiyadır, əslində DB lazımdır.
            if(userData.balance > players[userId].balance) {
                 players[userId].balance = userData.balance;
            }
            playerStates[userId] = 'AVAILABLE';
        }

        io.emit('updatePlayerList', getLobbyPlayers());
        io.emit('updateLeaderboard', getLeaderboard());
    });

    // 2. DƏVƏT SİSTEMİ
    socket.on('sendInvite', (targetUserId) => {
        const senderUserId = socketMap[socket.id];
        if (!senderUserId || !players[targetUserId]) return;

        const sender = players[senderUserId];
        const target = players[targetUserId];

        // Spam Check
        const cooldownKey = `${senderUserId}_${targetUserId}`;
        if (Date.now() - (inviteCooldowns[cooldownKey] || 0) < 10000) {
            io.to(sender.socketId).emit('errorMsg', "⏳ Biraz səbirli ol...");
            return;
        }

        // Status Check
        if (playerStates[senderUserId] !== 'AVAILABLE' || playerStates[targetUserId] !== 'AVAILABLE') {
            io.to(sender.socketId).emit('errorMsg', "❌ Oyunçu məşğuldur.");
            return;
        }

        playerStates[senderUserId] = 'BUSY';
        playerStates[targetUserId] = 'BUSY';
        inviteCooldowns[cooldownKey] = Date.now();

        // Hədəfin yeni socket ID-sinə göndər
        io.to(target.socketId).emit('receiveInvite', {
            fromId: senderUserId, // User ID göndəririk
            fromName: sender.name,
            fromAvatar: sender.avatar
        });

        // Timeout (15 san)
        setTimeout(() => {
            if (playerStates[senderUserId] === 'BUSY' && playerStates[targetUserId] === 'BUSY') {
                playerStates[senderUserId] = 'AVAILABLE';
                playerStates[targetUserId] = 'AVAILABLE';
            }
        }, 15000);
    });

    // 3. DƏVƏT CAVABI
    socket.on('inviteResponse', (data) => {
        const senderUserId = data.fromId;
        const receiverUserId = socketMap[socket.id];

        if (data.accepted) {
            createGame(senderUserId, receiverUserId);
        } else {
            if (players[senderUserId]) playerStates[senderUserId] = 'AVAILABLE';
            if (players[receiverUserId]) playerStates[receiverUserId] = 'AVAILABLE';
            
            if (players[senderUserId]) {
                io.to(players[senderUserId].socketId).emit('errorMsg', "ℹ️ Dəvət rədd edildi.");
            }
        }
    });

    function createGame(p1Id, p2Id) {
        if (!players[p1Id] || !players[p2Id]) return;

        playerStates[p1Id] = 'PLAYING';
        playerStates[p2Id] = 'PLAYING';

        const gameId = 'match_' + Date.now();
        activeGames[gameId] = { 
            p1: p1Id, p2: p2Id, 
            p1Roll: null, p2Roll: null, 
            p1Health: 100, p2Health: 100 
        };

        const p1Socket = players[p1Id].socketId;
        const p2Socket = players[p2Id].socketId;

        io.to(p1Socket).emit('gameStart', { gameId, opponent: players[p2Id] });
        io.to(p2Socket).emit('gameStart', { gameId, opponent: players[p1Id] });
        
        io.emit('updatePlayerList', getLobbyPlayers());
    }

    // 4. OYUN MƏNTİQİ
    socket.on('rollDice', (gameId) => {
        const game = activeGames[gameId];
        if (!game) return;
        
        const rollerUserId = socketMap[socket.id];
        const roll = Math.floor(Math.random() * 6) + 1;

        if (rollerUserId === game.p1) game.p1Roll = roll;
        else if (rollerUserId === game.p2) game.p2Roll = roll;

        // Nəticəni hər iki tərəfin socket-inə göndər
        const s1 = players[game.p1]?.socketId;
        const s2 = players[game.p2]?.socketId;

        if(s1) io.to(s1).emit('rollResult', { roller: rollerUserId, roll });
        if(s2) io.to(s2).emit('rollResult', { roller: rollerUserId, roll });

        if (game.p1Roll && game.p2Roll) {
            setTimeout(() => calculateRound(gameId), 2000);
        }
    });

    function calculateRound(gameId) {
        const game = activeGames[gameId];
        if (!game) return;
        
        let msg = "Heç-heçə!";
        if (game.p1Roll > game.p2Roll) {
            const dmg = (game.p1Roll - game.p2Roll) * 10;
            game.p2Health = Math.max(0, game.p2Health - dmg);
            msg = `P1 vurdu! (-${dmg})`;
        } else if (game.p2Roll > game.p1Roll) {
            const dmg = (game.p2Roll - game.p1Roll) * 10;
            game.p1Health = Math.max(0, game.p1Health - dmg);
            msg = `P2 vurdu! (-${dmg})`;
        }

        const s1 = players[game.p1]?.socketId;
        const s2 = players[game.p2]?.socketId;

        const updateData = { myHp: game.p1Health, oppHp: game.p2Health, msg }; 
        const updateDataP2 = { myHp: game.p2Health, oppHp: game.p1Health, msg };

        if(s1) io.to(s1).emit('healthUpdate', updateData);
        if(s2) io.to(s2).emit('healthUpdate', updateDataP2);

        if (game.p1Health === 0 || game.p2Health === 0) {
            const winnerId = game.p1Health > 0 ? game.p1 : game.p2;
            endGame(gameId, winnerId);
        } else {
            game.p1Roll = null; game.p2Roll = null;
            if(s1) io.to(s1).emit('nextRound');
            if(s2) io.to(s2).emit('nextRound');
        }
    }

    function endGame(gameId, winnerId) {
        const game = activeGames[gameId];
        const loserId = winnerId === game.p1 ? game.p2 : game.p1;
        
        if(players[winnerId]) { 
            players[winnerId].balance += 100; 
            playerStates[winnerId] = 'AVAILABLE'; 
        }
        if(players[loserId]) { 
            players[loserId].balance -= 100; 
            playerStates[loserId] = 'AVAILABLE'; 
        }

        const sWin = players[winnerId]?.socketId;
        const sLose = players[loserId]?.socketId;

        if(sWin) io.to(sWin).emit('gameOver', { won: true, newBalance: players[winnerId].balance });
        if(sLose) io.to(sLose).emit('gameOver', { won: false, newBalance: players[loserId].balance });
        
        delete activeGames[gameId];
        
        io.emit('updateLeaderboard', getLeaderboard());
        io.emit('updatePlayerList', getLobbyPlayers());
    }

    socket.on('disconnect', () => {
        // User məlumatlarını silmirik, sadəcə socket map-dən çıxarırıq
        // Amma listdən gizlədə bilərik ki, offline görünsün
        const userId = socketMap[socket.id];
        if (userId) {
            delete socketMap[socket.id];
            // players[userId]-ni silmirik ki, qayıdanda tanıyıq
            // Amma lobbi listində görünməməsi üçün:
            if(players[userId]) players[userId].socketId = null; 
        }
        io.emit('updatePlayerList', getLobbyPlayers());
    });

    function getLobbyPlayers() { 
        return Object.values(players).filter(p => p.socketId && playerStates[p.id] === 'AVAILABLE'); 
    }
    
    function getLeaderboard() { 
        return Object.values(players)
            .sort((a,b) => b.balance - a.balance)
            .slice(0,5); 
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server: ${PORT}`));
