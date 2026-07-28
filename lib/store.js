'use strict';

/**
 * Shared in-memory room store for the serverless (Vercel) Planning Poker.
 *
 * IMPORTANT: Vercel serverless functions are ephemeral and there may be more
 * than one warm instance. This module-scoped store therefore persists only on
 * a best-effort basis (good enough for a small group hitting the same region;
 * a cold start or a second instance can reset/split state). For durable state,
 * swap the `rooms` object for Vercel KV / Upstash Redis behind the same
 * function signatures below.
 *
 * Because there is no persistent socket, each client generates its own
 * `playerId` (persisted in localStorage) and sends it on every request. We
 * track `lastSeen` per player and prune players who stop polling.
 */

// Players who haven't polled/acted within this window are considered gone.
const STALE_MS = 20000;

/**
 * rooms[roomId] = {
 *   topic, revealed, hostId, roundCount,
 *   players: { [playerId]: { id, name, isSpectator, vote, lastSeen } },
 *   history: [{ round, topic, stats, votes:[{name,vote}], at }]
 * }
 */
const rooms = Object.create(null);

function createRoom() {
  return {
    topic: '',
    revealed: false,
    hostId: null,
    roundCount: 0,
    players: Object.create(null),
    history: [],
  };
}

function getOrCreateRoom(roomId) {
  if (!rooms[roomId]) rooms[roomId] = createRoom();
  return rooms[roomId];
}

/** Remove players who haven't been seen recently; fix up host / empty rooms. */
function pruneRoom(roomId) {
  const room = rooms[roomId];
  if (!room) return null;

  const now = Date.now();
  for (const pid of Object.keys(room.players)) {
    if (now - room.players[pid].lastSeen > STALE_MS) {
      delete room.players[pid];
    }
  }

  const remaining = Object.keys(room.players);
  if (remaining.length === 0) {
    delete rooms[roomId];
    return null;
  }

  // Reassign host if the current host is gone.
  if (!room.hostId || !room.players[room.hostId]) {
    // Oldest-joined remaining player (smallest lastSeen is a rough proxy;
    // we instead just take the first key for stability).
    room.hostId = remaining[0];
  }
  return room;
}

/**
 * Compute vote statistics for a room's players map.
 * Mirrors the original server semantics exactly.
 */
function computeStats(players) {
  const castVotes = Object.values(players)
    .map((p) => p.vote)
    .filter((v) => v !== null && v !== undefined);

  const count = castVotes.length;
  if (count === 0) {
    return { average: null, mode: null, count: 0, agreement: false };
  }

  const numericVotes = castVotes
    .map((v) => Number(v))
    .filter((n) => !Number.isNaN(n) && Number.isFinite(n));

  let average = null;
  if (numericVotes.length > 0) {
    const sum = numericVotes.reduce((a, b) => a + b, 0);
    average = Math.round((sum / numericVotes.length) * 10) / 10;
  }

  const freq = new Map();
  for (const v of castVotes) freq.set(v, (freq.get(v) || 0) + 1);
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
 * Build the public, serializable state payload for a room. `revealed` gates
 * whether individual vote values are exposed (same rule as the socket app).
 * Returns a valid "empty" payload if the room no longer exists.
 */
function publicState(roomId) {
  const room = pruneRoom(roomId);
  if (!room) {
    return {
      roomId,
      topic: '',
      revealed: false,
      players: [],
      stats: { average: null, mode: null, count: 0, agreement: false },
      hostId: null,
      history: [],
    };
  }

  const players = Object.values(room.players).map((p) => ({
    id: p.id,
    name: p.name,
    isSpectator: p.isSpectator,
    hasVoted: p.vote !== null && p.vote !== undefined,
    vote: room.revealed ? (p.vote === undefined ? null : p.vote) : null,
  }));

  return {
    roomId,
    topic: room.topic,
    revealed: room.revealed,
    players,
    stats: computeStats(room.players),
    hostId: room.hostId,
    history: room.history,
  };
}

/** Mark a player as active (touch lastSeen). No-op if room/player absent. */
function touch(roomId, playerId) {
  const room = rooms[roomId];
  if (room && room.players[playerId]) {
    room.players[playerId].lastSeen = Date.now();
  }
}

// ---------------------------------------------------------------------------
// Mutations. Each returns { ok: true } or { ok: false, error: string }.
// Callers then read publicState(roomId) for the fresh view.
// ---------------------------------------------------------------------------

function join(roomId, playerId, name, isSpectator) {
  if (!roomId || !playerId) return { ok: false, error: 'roomId and playerId are required.' };
  const room = getOrCreateRoom(roomId);

  const existing = room.players[playerId];
  room.players[playerId] = {
    id: playerId,
    name: typeof name === 'string' && name.trim() ? name.trim() : 'Anonymous',
    isSpectator: Boolean(isSpectator),
    vote: existing ? existing.vote : null,
    lastSeen: Date.now(),
  };

  if (!room.hostId || !room.players[room.hostId]) {
    room.hostId = playerId;
  }
  return { ok: true };
}

function vote(roomId, playerId, value) {
  const room = rooms[roomId];
  if (!room) return { ok: false, error: 'Room not found.' };
  const player = room.players[playerId];
  if (!player) return { ok: false, error: 'You are not in this room.' };
  if (room.revealed) return { ok: false, error: 'Voting is closed until the round is reset.' };
  if (typeof value !== 'string') return { ok: false, error: 'Vote value must be a string.' };
  player.vote = value;
  player.lastSeen = Date.now();
  return { ok: true };
}

function reveal(roomId, playerId) {
  const room = rooms[roomId];
  if (!room) return { ok: false, error: 'Room not found.' };
  if (playerId !== room.hostId) return { ok: false, error: 'Only the host can reveal the cards.' };

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
  return { ok: true };
}

function reset(roomId, playerId) {
  const room = rooms[roomId];
  if (!room) return { ok: false, error: 'Room not found.' };
  if (playerId !== room.hostId) return { ok: false, error: 'Only the host can start a new round.' };
  room.revealed = false;
  for (const p of Object.values(room.players)) p.vote = null;
  return { ok: true };
}

function setTopic(roomId, playerId, topic) {
  const room = rooms[roomId];
  if (!room) return { ok: false, error: 'Room not found.' };
  if (!room.players[playerId]) return { ok: false, error: 'You are not in this room.' };
  room.topic = typeof topic === 'string' ? topic : '';
  return { ok: true };
}

function changeName(roomId, playerId, name) {
  const room = rooms[roomId];
  if (!room) return { ok: false, error: 'Room not found.' };
  const player = room.players[playerId];
  if (!player) return { ok: false, error: 'You are not in this room.' };
  if (typeof name === 'string' && name.trim()) player.name = name.trim();
  return { ok: true };
}

function leave(roomId, playerId) {
  const room = rooms[roomId];
  if (!room) return { ok: true };
  delete room.players[playerId];
  if (Object.keys(room.players).length === 0) {
    delete rooms[roomId];
  } else if (playerId === room.hostId) {
    room.hostId = Object.keys(room.players)[0];
  }
  return { ok: true };
}

module.exports = {
  rooms,
  computeStats,
  publicState,
  touch,
  join,
  vote,
  reveal,
  reset,
  setTopic,
  changeName,
  leave,
};
