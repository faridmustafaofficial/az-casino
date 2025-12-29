const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

let players = {};      
let activeGames = {};  
let inviteCooldowns = {}; 
let playerStates = {}; 

io.on('connection', (socket) => {
    // console.log('🔗 Yeni qoşulma:', socket.id); // Logları azaltdıq

    socket.on('login', (userData) => {
        players[socket.id] = {
            id: socket.id,
            name: userData.name,
            balance: userData.balance,
            avatar: userData.avatar,
            gamesPlayed: 0
        };
        playerStates[socket.id] = 'AVAILABLE';
        io.emit('updatePlayerList', getLobbyPlayers());
        io.emit('updateLeaderboard', getLeaderboard());
    });

    socket.on('sendInvite', (targetId) => {
        const senderId = socket.id;
        if (!players[targetId] || !players[senderId]) return;
        
        const cooldownKey = `${senderId}_${targetId}`;
        if (Date.now() - (inviteCooldowns[cooldownKey] || 0) < 10000) {
            io.to(senderId).emit('errorMsg', "⏳ Biraz səbirli ol...");
            return;
        }

        if (playerStates[senderId] !== 'AVAILABLE' || playerStates[targetId] !== 'AVAILABLE') {
            io.to(senderId).emit('errorMsg', "❌ Oyunçu məşğuldur.");
            return;
        }

        playerStates[senderId] = 'BUSY';
        playerStates[targetId] = 'BUSY';
        inviteCooldowns[cooldownKey] = Date.now();

        io.to(targetId).emit('receiveInvite', {
            fromId: senderId,
            fromName: players[senderId].name,
            fromAvatar: players[senderId].avatar
        });

        setTimeout(() => {
            if (playerStates[senderId] === 'BUSY' && playerStates[targetId] === 'BUSY' && !hasActiveGame(senderId)) {
                playerStates[senderId] = 'AVAILABLE';
                playerStates[targetId] = 'AVAILABLE';
            }
        }, 15000);
    });

    socket.on('inviteResponse', (data) => {
        const senderId = data.fromId;
        const receiverId = socket.id;

        if (data.accepted) {
            createGame(senderId, receiverId);
        } else {
            if (players[senderId]) playerStates[senderId] = 'AVAILABLE';
            playerStates[receiverId] = 'AVAILABLE';
            if (players[senderId]) io.to(senderId).emit('errorMsg', "ℹ️ Dəvət rədd edildi.");
        }
    });

    function createGame(p1, p2) {
        if (!players[p1] || !players[p2]) {
            playerStates[p1] = 'AVAILABLE'; playerStates[p2] = 'AVAILABLE'; return;
        }
        playerStates[p1] = 'PLAYING'; playerStates[p2] = 'PLAYING';

        const gameId = 'match_' + Date.now();
        activeGames[gameId] = { 
            p1, p2, p1Roll: null, p2Roll: null, p1Health: 100, p2Health: 100 
        };

        io.to(p1).emit('gameStart', { gameId, opponent: players[p2] });
        io.to(p2).emit('gameStart', { gameId, opponent: players[p1] });
        io.emit('updatePlayerList', getLobbyPlayers());
    }

    socket.on('rollDice', (gameId) => {
        const game = activeGames[gameId];
        if (!game) return;
        const roll = Math.floor(Math.random() * 6) + 1;

        if (socket.id === game.p1) game.p1Roll = roll;
        else game.p2Roll = roll;

        io.to(game.p1).emit('rollResult', { roller: socket.id, roll });
        io.to(game.p2).emit('rollResult', { roller: socket.id, roll });

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

        io.to(game.p1).emit('healthUpdate', { myHp: game.p1Health, oppHp: game.p2Health, msg });
        io.to(game.p2).emit('healthUpdate', { myHp: game.p2Health, oppHp: game.p1Health, msg });

        if (game.p1Health === 0 || game.p2Health === 0) {
            const winner = game.p1Health > 0 ? game.p1 : game.p2;
            endGame(gameId, winner);
        } else {
            game.p1Roll = null; game.p2Roll = null;
            io.to(game.p1).emit('nextRound'); io.to(game.p2).emit('nextRound');
        }
    }

    function endGame(gameId, winnerId) {
        const game = activeGames[gameId];
        const loserId = winnerId === game.p1 ? game.p2 : game.p1;
        
        if(players[winnerId]) { players[winnerId].balance += 100; playerStates[winnerId] = 'AVAILABLE'; }
        if(players[loserId]) { players[loserId].balance -= 100; playerStates[loserId] = 'AVAILABLE'; }

        io.to(winnerId).emit('gameOver', { won: true });
        io.to(loserId).emit('gameOver', { won: false });
        delete activeGames[gameId];
        
        io.emit('updateLeaderboard', getLeaderboard());
        io.emit('updatePlayerList', getLobbyPlayers());
    }

    socket.on('disconnect', () => {
        delete players[socket.id]; delete playerStates[socket.id];
        io.emit('updatePlayerList', getLobbyPlayers());
    });

    function getLobbyPlayers() { return Object.values(players).filter(p => playerStates[p.id] === 'AVAILABLE'); }
    function getLeaderboard() { return Object.values(players).sort((a,b) => b.balance - a.balance).slice(0,5); }
    function hasActiveGame(id) { return Object.values(activeGames).some(g => g.p1 === id || g.p2 === id); }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server: ${PORT}`));