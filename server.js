'use strict';

/**
 * Planning Poker realtime backend.
 *
 * Express serves the static frontend from ./public and a Socket.IO server
 * handles all realtime room/voting logic. Rooms live entirely in memory
 * (a plain object keyed by roomId) and are deleted as soon as they become
 * empty — there is no persistence and none is required for this use case.
 */

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// Serve the frontend (built separately) from the public/ directory.
app.use(express.static(path.join(__dirname, 'public')));

// Simple liveness endpoint for load balancers / uptime checks.
app.get('/healthz', (req, res) => {
  res.status(200).send('ok');
});

/**
 * In-memory room store.
 *
 * rooms[roomId] = {
 *   topic: string,
 *   revealed: boolean,
 *   players: {
 *     [socketId]: { id, name, isSpectator, vote: string|null }
 *   },
 *   hostId: string|null
 * }
 */
const rooms = {};

/** Create a fresh, empty room object. */
function createRoom() {
  return {
    topic: '',
    revealed: false,
    players: {},
    hostId: null,
    // Completed rounds, most-recent-last. Each entry:
    // { round, topic, stats, votes: [{ name, vote }], at }
    history: [],
    roundCount: 0,
  };
}

/** Get a room by id, creating it on first access. */
function getOrCreateRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = createRoom();
  }
  return rooms[roomId];
}

/**
 * Compute vote statistics for a room.
 * - average: numeric mean of numeric votes, rounded to 1 decimal, or null
 * - mode: most common cast vote value (any type, including "?"/"☕"), or null
 * - count: number of votes cast (any type)
 * - agreement: true if there is at least one numeric vote and all numeric
 *   votes are equal to each other (ignoring non-numeric votes)
 */
function computeStats(players) {
  const castVotes = Object.values(players)
    .map((p) => p.vote)
    .filter((v) => v !== null && v !== undefined);

  const count = castVotes.length;

  if (count === 0) {
    return { average: null, mode: null, count: 0, agreement: false };
  }

  // Numeric votes only (exclude non-numeric special cards like "?" or "☕").
  const numericVotes = castVotes
    .map((v) => Number(v))
    .filter((n) => !Number.isNaN(n) && Number.isFinite(n));

  let average = null;
  if (numericVotes.length > 0) {
    const sum = numericVotes.reduce((a, b) => a + b, 0);
    average = Math.round((sum / numericVotes.length) * 10) / 10;
  }

  // Mode: most frequent raw vote value. Ties broken by first-seen order.
  const freq = new Map();
  for (const v of castVotes) {
    freq.set(v, (freq.get(v) || 0) + 1);
  }
  let mode = null;
  let modeCount = 0;
  for (const v of castVotes) {
    const c = freq.get(v);
    if (c > modeCount) {
      modeCount = c;
      mode = v;
    }
  }

  const agreement =
    numericVotes.length > 0 && numericVotes.every((n) => n === numericVotes[0]);

  return { average, mode, count, agreement };
}

/**
 * Build the public `state` payload for a room and broadcast it to every
 * socket currently joined to that room's Socket.IO room channel.
 */
function broadcastState(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const players = Object.values(room.players).map((p) => ({
    id: p.id,
    name: p.name,
    isSpectator: p.isSpectator,
    hasVoted: p.vote !== null && p.vote !== undefined,
    // Only reveal the actual vote value once the round has been revealed.
    vote: room.revealed ? (p.vote === undefined ? null : p.vote) : null,
  }));

  const stats = computeStats(room.players);

  const payload = {
    roomId,
    topic: room.topic,
    revealed: room.revealed,
    players,
    stats,
    hostId: room.hostId,
    history: room.history,
  };

  io.to(roomId).emit('state', payload);
}

/** Remove a socket's player entry from a room; delete the room if empty. */
function removePlayerFromRoom(socket, roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const wasHost = room.hostId === socket.id;
  delete room.players[socket.id];

  if (Object.keys(room.players).length === 0) {
    delete rooms[roomId];
  } else {
    if (wasHost) {
      room.hostId = Object.keys(room.players)[0];
    }
    broadcastState(roomId);
  }
}

io.on('connection', (socket) => {
  // Tracks which room this socket currently belongs to (a socket only
  // ever belongs to a single room at a time in this app).
  let currentRoomId = null;

  socket.on('join', (payload) => {
    try {
      const { roomId, name, isSpectator } = payload || {};

      if (!roomId || typeof roomId !== 'string') {
        socket.emit('error', { message: 'roomId is required to join a room.' });
        return;
      }

      // If this socket had already joined a different room, leave it first.
      if (currentRoomId && currentRoomId !== roomId) {
        socket.leave(currentRoomId);
        removePlayerFromRoom(socket, currentRoomId);
      }

      const room = getOrCreateRoom(roomId);

      room.players[socket.id] = {
        id: socket.id,
        name: typeof name === 'string' && name.trim() ? name.trim() : 'Anonymous',
        isSpectator: Boolean(isSpectator),
        vote: null,
      };

      // First joiner (or first remaining player after the host left)
      // becomes the host.
      if (!room.hostId || !room.players[room.hostId]) {
        room.hostId = socket.id;
      }

      currentRoomId = roomId;
      socket.join(roomId);

      // Let the joining socket know its own id / room.
      socket.emit('joined', { selfId: socket.id, roomId });

      broadcastState(roomId);
    } catch (err) {
      socket.emit('error', { message: 'Failed to join room.' });
    }
  });

  socket.on('vote', (payload) => {
    try {
      if (!currentRoomId || !rooms[currentRoomId]) {
        socket.emit('error', { message: 'You are not in a room.' });
        return;
      }

      const room = rooms[currentRoomId];

      if (room.revealed) {
        socket.emit('error', { message: 'Voting is closed until the round is reset.' });
        return;
      }

      const player = room.players[socket.id];
      if (!player) {
        socket.emit('error', { message: 'Player not found in room.' });
        return;
      }

      const { value } = payload || {};
      if (typeof value !== 'string') {
        socket.emit('error', { message: 'Vote value must be a string.' });
        return;
      }

      player.vote = value;
      broadcastState(currentRoomId);
    } catch (err) {
      socket.emit('error', { message: 'Failed to record vote.' });
    }
  });

  socket.on('reveal', () => {
    try {
      if (!currentRoomId || !rooms[currentRoomId]) {
        socket.emit('error', { message: 'You are not in a room.' });
        return;
      }

      if (socket.id !== rooms[currentRoomId].hostId) {
        socket.emit('error', { message: 'Only the host can reveal the cards.' });
        return;
      }

      const room = rooms[currentRoomId];

      // Only record a history entry on the transition into "revealed",
      // and only when at least one vote was cast.
      if (!room.revealed) {
        const stats = computeStats(room.players);
        if (stats.count > 0) {
          const votes = Object.values(room.players)
            .filter((p) => p.vote !== null && p.vote !== undefined)
            .map((p) => ({ name: p.name, vote: p.vote }));

          room.roundCount += 1;
          room.history.push({
            round: room.roundCount,
            topic: room.topic || '',
            stats,
            votes,
            at: Date.now(),
          });
        }
      }

      room.revealed = true;
      broadcastState(currentRoomId);
    } catch (err) {
      socket.emit('error', { message: 'Failed to reveal votes.' });
    }
  });

  socket.on('reset', () => {
    try {
      if (!currentRoomId || !rooms[currentRoomId]) {
        socket.emit('error', { message: 'You are not in a room.' });
        return;
      }

      if (socket.id !== rooms[currentRoomId].hostId) {
        socket.emit('error', { message: 'Only the host can start a new round.' });
        return;
      }

      const room = rooms[currentRoomId];
      room.revealed = false;
      for (const player of Object.values(room.players)) {
        player.vote = null;
      }
      broadcastState(currentRoomId);
    } catch (err) {
      socket.emit('error', { message: 'Failed to reset round.' });
    }
  });

  socket.on('setTopic', (payload) => {
    try {
      if (!currentRoomId || !rooms[currentRoomId]) {
        socket.emit('error', { message: 'You are not in a room.' });
        return;
      }

      const { topic } = payload || {};
      rooms[currentRoomId].topic = typeof topic === 'string' ? topic : '';
      broadcastState(currentRoomId);
    } catch (err) {
      socket.emit('error', { message: 'Failed to set topic.' });
    }
  });

  socket.on('changeName', (payload) => {
    try {
      if (!currentRoomId || !rooms[currentRoomId]) {
        socket.emit('error', { message: 'You are not in a room.' });
        return;
      }

      const room = rooms[currentRoomId];
      const player = room.players[socket.id];
      if (!player) {
        socket.emit('error', { message: 'Player not found in room.' });
        return;
      }

      const { name } = payload || {};
      if (typeof name === 'string' && name.trim()) {
        player.name = name.trim();
        broadcastState(currentRoomId);
      }
    } catch (err) {
      socket.emit('error', { message: 'Failed to change name.' });
    }
  });

  socket.on('disconnect', () => {
    if (currentRoomId) {
      removePlayerFromRoom(socket, currentRoomId);
      currentRoomId = null;
    }
  });
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`Planning Poker server listening on http://${HOST}:${PORT}`);
});

module.exports = { app, server, io, rooms };
