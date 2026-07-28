'use strict';

/**
 * Shared room store for the serverless (Vercel) Planning Poker, backed by
 * Upstash Redis over its REST API.
 *
 * WHY REDIS: on Vercel, `api/state.js` and `api/action.js` run as SEPARATE
 * serverless functions, each in its own isolated process/memory. An in-memory
 * object therefore cannot be shared between them (a vote written by one
 * function is invisible to the other, and cold starts wipe it). A small
 * external store fixes this. Upstash's REST client is stateless and works
 * perfectly in serverless (no connection pooling to manage).
 *
 * CONFIG: set these in your Vercel project (either name pair works — the
 * Upstash Vercel integration and Vercel KV inject different names):
 *   UPSTASH_REDIS_REST_URL   / KV_REST_API_URL
 *   UPSTASH_REDIS_REST_TOKEN / KV_REST_API_TOKEN
 *
 * DATA MODEL: one JSON blob per room under key `pp:room:<roomId>`, with a TTL
 * so abandoned rooms self-clean. Mutations are read-modify-write; for a small
 * estimation group the race window is negligible.
 */

const { Redis } = require('@upstash/redis');

const REST_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

// Room key TTL: rooms with no activity vanish after this many seconds.
const ROOM_TTL_SECONDS = 6 * 60 * 60; // 6 hours
// A player who hasn't polled/acted within this window is pruned.
const STALE_MS = 30000;
// Only rewrite lastSeen if it's older than this (limits Redis writes on poll).
const TOUCH_WRITE_MS = 8000;

const key = (roomId) => 'pp:room:' + roomId;

let _redis = null;
function getRedis() {
  if (!REST_URL || !REST_TOKEN) {
    const e = new Error(
      'Storage not configured: set UPSTASH_REDIS_REST_URL and ' +
        'UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_URL / KV_REST_API_TOKEN) ' +
        'in your Vercel project environment variables.'
    );
    e.code = 'NO_STORAGE';
    throw e;
  }
  if (!_redis) {
    _redis = new Redis({ url: REST_URL, token: REST_TOKEN });
  }
  return _redis;
}

// ---------------------------------------------------------------------------
// Low-level persistence
// ---------------------------------------------------------------------------

async function loadRoom(roomId) {
  const room = await getRedis().get(key(roomId)); // auto-deserialized JSON
  return room || null;
}

async function saveRoom(roomId, room) {
  await getRedis().set(key(roomId), room, { ex: ROOM_TTL_SECONDS });
}

async function deleteRoom(roomId) {
  await getRedis().del(key(roomId));
}

// ---------------------------------------------------------------------------
// Pure helpers (no I/O)
// ---------------------------------------------------------------------------

function createRoom() {
  return {
    topic: '',
    revealed: false,
    hostId: null,
    roundCount: 0,
    players: {},
    history: [],
  };
}

function emptyState(roomId) {
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

/** Remove stale players and reassign host if needed. Returns true if changed. */
function pruneInPlace(room) {
  const now = Date.now();
  let changed = false;

  for (const pid of Object.keys(room.players)) {
    if (now - room.players[pid].lastSeen > STALE_MS) {
      delete room.players[pid];
      changed = true;
    }
  }

  const remaining = Object.keys(room.players);
  if (remaining.length > 0 && (!room.hostId || !room.players[room.hostId])) {
    room.hostId = remaining[0];
    changed = true;
  }
  return changed;
}

/** Vote statistics — identical semantics to the original Socket.IO server. */
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

/** Build the public, serializable view for a loaded room. */
function viewOf(room, roomId) {
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

// ---------------------------------------------------------------------------
// Read path (polling)
// ---------------------------------------------------------------------------

/**
 * Read a room's state for polling. Touches the requesting player's lastSeen
 * (throttled to limit writes) and prunes stale players. Returns the view.
 */
async function getState(roomId, playerId) {
  const room = await loadRoom(roomId);
  if (!room) return emptyState(roomId);

  let changed = false;

  if (playerId && room.players[playerId]) {
    const now = Date.now();
    if (now - room.players[playerId].lastSeen > TOUCH_WRITE_MS) {
      room.players[playerId].lastSeen = now;
      changed = true;
    }
  }

  if (pruneInPlace(room)) changed = true;

  if (Object.keys(room.players).length === 0) {
    await deleteRoom(roomId);
    return emptyState(roomId);
  }

  if (changed) await saveRoom(roomId, room);
  return viewOf(room, roomId);
}

// ---------------------------------------------------------------------------
// Write path (mutations)
//
// Each mutation loads the room, applies an in-place mutator, prunes, and saves.
// Every mutation returns { ok, error?, state } so the API handler can respond
// with the fresh view in a single round trip (no extra read).
// ---------------------------------------------------------------------------

async function withRoom(roomId, opts, mutator) {
  let room = await loadRoom(roomId);

  if (!room) {
    if (opts.create) {
      room = createRoom();
    } else if (opts.okIfMissing) {
      return { ok: true, state: emptyState(roomId) };
    } else {
      return { ok: false, error: 'Room not found.', state: emptyState(roomId) };
    }
  }

  const res = mutator(room);
  if (!res.ok) {
    return { ok: false, error: res.error, state: viewOf(room, roomId) };
  }

  pruneInPlace(room);

  if (Object.keys(room.players).length === 0) {
    await deleteRoom(roomId);
    return { ok: true, state: emptyState(roomId) };
  }

  await saveRoom(roomId, room);
  return { ok: true, state: viewOf(room, roomId) };
}

function join(roomId, playerId, name, isSpectator) {
  if (!roomId || !playerId) {
    return Promise.resolve({
      ok: false,
      error: 'roomId and playerId are required.',
      state: emptyState(roomId),
    });
  }
  return withRoom(roomId, { create: true }, (room) => {
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
  });
}

function vote(roomId, playerId, value) {
  return withRoom(roomId, {}, (room) => {
    const player = room.players[playerId];
    if (!player) return { ok: false, error: 'You are not in this room.' };
    if (room.revealed) return { ok: false, error: 'Voting is closed until the round is reset.' };
    if (typeof value !== 'string') return { ok: false, error: 'Vote value must be a string.' };
    player.vote = value;
    player.lastSeen = Date.now();
    return { ok: true };
  });
}

function reveal(roomId, playerId) {
  return withRoom(roomId, {}, (room) => {
    if (playerId !== room.hostId) {
      return { ok: false, error: 'Only the host can reveal the cards.' };
    }
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
  });
}

function reset(roomId, playerId) {
  return withRoom(roomId, {}, (room) => {
    if (playerId !== room.hostId) {
      return { ok: false, error: 'Only the host can start a new round.' };
    }
    room.revealed = false;
    for (const p of Object.values(room.players)) p.vote = null;
    return { ok: true };
  });
}

function setTopic(roomId, playerId, topic) {
  return withRoom(roomId, {}, (room) => {
    if (!room.players[playerId]) return { ok: false, error: 'You are not in this room.' };
    room.topic = typeof topic === 'string' ? topic : '';
    return { ok: true };
  });
}

function changeName(roomId, playerId, name) {
  return withRoom(roomId, {}, (room) => {
    const player = room.players[playerId];
    if (!player) return { ok: false, error: 'You are not in this room.' };
    if (typeof name === 'string' && name.trim()) player.name = name.trim();
    return { ok: true };
  });
}

function leave(roomId, playerId) {
  return withRoom(roomId, { okIfMissing: true }, (room) => {
    delete room.players[playerId];
    if (playerId === room.hostId) {
      const remaining = Object.keys(room.players);
      room.hostId = remaining.length ? remaining[0] : null;
    }
    return { ok: true };
  });
}

module.exports = {
  computeStats,
  getState,
  join,
  vote,
  reveal,
  reset,
  setTopic,
  changeName,
  leave,
};
