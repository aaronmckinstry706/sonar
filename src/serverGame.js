const http = require('http');
const { Server } = require('socket.io');

function createServerGameState() {
  return {
    phase: 'not_started',
    gameAdminId: null,
    lobby: {
      players: {},
      roles: {},
    },
    game: {
      // extend with actual gameplay specific data when the match begins
    },
  };
}

function createAndRunServer(port, gameState) {
  if (!gameState || typeof gameState !== 'object') {
    throw new Error('gameState must be an object created by createServerGameState');
  }

  const server = http.createServer();
  const io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  const getAllPlayers = () => Object.values(gameState.lobby.players);

  const getAssignedPlayers = () => getAllPlayers().filter((player) => player.role && player.sub && player.team);

  const broadcastLobbyState = () => {
    io.emit('lobby_state', {
      phase: gameState.phase,
      gameAdmin: gameState.gameAdminId,
      players: gameState.lobby.players,
      roles: gameState.lobby.roles,
    });
  };

  const emitGameState = (socket) => {
    socket.emit('begin_game', {
      phase: gameState.phase,
      game: gameState.game,
      roles: gameState.lobby.roles,
    });
  };

  const setAdminIfNeeded = (socketId) => {
    if (!gameState.gameAdminId) {
      gameState.gameAdminId = socketId;
    }
  };

  const removeRoleAssignment = (playerId) => {
    const player = gameState.lobby.players[playerId];
    if (!player || !player.sub || !player.team || !player.role) {
      return;
    }

    const { sub, team, role } = player;
    const subState = gameState.lobby.roles[sub];

    if (subState && subState[team] && subState[team][role] === playerId) {
      delete subState[team][role];
      if (Object.keys(subState[team]).length === 0) {
        delete subState[team];
      }
      if (Object.keys(subState).length === 0) {
        delete gameState.lobby.roles[sub];
      }
    }

    player.sub = null;
    player.team = null;
    player.role = null;
  };

  const assignRole = (playerId, selection) => {
    const player = gameState.lobby.players[playerId];
    if (!player) {
      return false;
    }

    const { sub, team, role } = selection;

    if (!sub || !team || !role) {
      return false;
    }

    if (!gameState.lobby.roles[sub]) {
      gameState.lobby.roles[sub] = {};
    }
    if (!gameState.lobby.roles[sub][team]) {
      gameState.lobby.roles[sub][team] = {};
    }

    if (gameState.lobby.roles[sub][team][role]) {
      return false;
    }

    removeRoleAssignment(playerId);

    gameState.lobby.roles[sub][team][role] = playerId;
    player.sub = sub;
    player.team = team;
    player.role = role;
    player.ready = false;
    player.resumeReady = false;
    return true;
  };

  const resetReadyStates = () => {
    Object.values(gameState.lobby.players).forEach((player) => {
      player.ready = false;
      player.resumeReady = false;
    });
  };

  const everyoneReady = () => {
    const players = getAllPlayers();
    if (players.length === 0) {
      return false;
    }
    return players.every((player) => player.ready);
  };

  const everyoneReadyToResume = () => {
    const assignedPlayers = getAssignedPlayers();
    if (assignedPlayers.length === 0) {
      return false;
    }
    return assignedPlayers.every((player) => player.resumeReady);
  };

  io.on('connection', (socket) => {
    const id = socket.id;

    setAdminIfNeeded(id);

    gameState.lobby.players[id] = {
      id,
      name: socket.handshake.query?.name || `Player ${id.substring(0, 5)}`,
      ready: false,
      resumeReady: false,
      connected: true,
      sub: null,
      team: null,
      role: null,
    };

    broadcastLobbyState();

    socket.on('select_team_and_role', (selection) => {
      if (assignRole(id, selection)) {
        broadcastLobbyState();
      } else {
        socket.emit('role_unavailable', selection);
      }
    });

    socket.on('leave_team_and_role', () => {
      removeRoleAssignment(id);
      const player = gameState.lobby.players[id];
      if (player) {
        player.ready = false;
        player.resumeReady = false;
      }
      broadcastLobbyState();
    });

    socket.on('player_ready', () => {
      const player = gameState.lobby.players[id];
      if (!player) {
        return;
      }
      player.ready = true;
      broadcastLobbyState();

      if (gameState.phase === 'not_started' && everyoneReady()) {
        gameState.phase = 'game_beginning';
        io.emit('game_beginning');
        setTimeout(() => {
          gameState.phase = 'captains_selecting_roles';
          gameState.game = {
            startedAt: Date.now(),
            roles: gameState.lobby.roles,
          };
          io.emit('begin_game', gameState.game);
          io.emit('captains_selecting_roles');
        }, 3000);
      }
    });

    socket.on('pause', () => {
      const player = gameState.lobby.players[id];
      if (!player || gameState.phase === 'paused' || player.role !== 'captain') {
        return;
      }
      gameState.phase = 'paused';
      Object.values(gameState.lobby.players).forEach((p) => {
        p.resumeReady = false;
      });
      io.emit('game_paused');
    });

    socket.on('ready', () => {
      const player = gameState.lobby.players[id];
      if (!player) {
        return;
      }
      player.resumeReady = true;
      io.emit('lobby_state', {
        phase: gameState.phase,
        gameAdmin: gameState.gameAdminId,
        players: gameState.lobby.players,
        roles: gameState.lobby.roles,
      });
      if (gameState.phase !== 'not_started') {
        emitGameState(socket);
      }
      if (gameState.phase === 'paused' && everyoneReadyToResume()) {
        gameState.phase = 'in_progress';
        Object.values(gameState.lobby.players).forEach((p) => {
          p.ready = false;
          p.resumeReady = false;
        });
        io.emit('resume_game');
      }
    });

    socket.on('disconnect', () => {
      const wasAdmin = gameState.gameAdminId === id;
      removeRoleAssignment(id);
      delete gameState.lobby.players[id];

      if (wasAdmin) {
        const firstPlayer = Object.keys(gameState.lobby.players)[0];
        gameState.gameAdminId = firstPlayer || null;
      }

      if (gameState.phase === 'in_progress') {
        gameState.phase = 'paused';
        io.emit('game_state', { phase: 'paused' });
      }

      broadcastLobbyState();
    });
  });

  const concludeGame = (result) => {
    gameState.phase = 'not_started';
    resetReadyStates();
    io.emit('game_over', result);
    broadcastLobbyState();
  };

  server.listen(port);
  return {
    server,
    io,
    concludeGame,
    emitGameState,
  };
}

module.exports = {
  createServerGameState,
  createAndRunServer,
};
