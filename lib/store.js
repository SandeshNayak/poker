'use strict';

/**
 * Shared room store for the serverless (Vercel) Planning Poker.
 *
 * WHY EXTERNAL STORAGE: on Vercel, `api/state.js` and `api/action.js` run as
 * SEPARATE serverless functions, each in its own isolated process/memory. An
 * in-memory object can't be shared between them (a vote written by one is
 * invisible to the other) and cold starts wipe it. So room state lives in an
 * external store.
 *
 * PLUGGABLE BACKENDS: this module keeps all the game logic pure and delegates
 * persistence to a small driver (loadRoom / saveRoom / deleteRoom). Two drivers
 * ship here and the right one is auto-selected from environment variables:
 *
 *   • Vercel Blob   — set when a Blob store is connected (BLOB_READ_WRITE_TOKEN
 *                     or BLOB_STORE_ID present). Stores one JSON blob per room.
 *   • Upstash Redis — set when a Redis/KV store is connected (UPSTASH_REDIS_REST_*
 *                     or KV_REST_API_* present). Faster; supports TTL.
 *
 * Force one explicitly with STORAGE_DRIVER=blob | redis. If neither is
 * configured, calls throw a NO_STORAGE error and the API returns HTTP 503.
 *
 * CONCURRENCY: mutations are read-modify-write. For a small estimation group
 * the race window is negligible; this is intentionally simple.
 */

// --- tunables --------------------------------------------------------------
const ROOM_TTL_SECONDS = 6 * 60 * 60; // Redis key TTL (Blob has no TTL — see note)
const STALE_MS = 30000; // prune a player who hasn't polled/acted within this
const TOUCH_WRITE_MS = 8000; // only rewrite lastSeen if older than this (limits writes)

// --- backend config --------------------------------------------------------
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const BLOB_STORE_ID = process.env.BLOB_STORE_ID;
const BLOB_ACCESS = process.env.BLOB_ACCESS || 'private';
const BLOB_AVAILABLE = Boolean(BLOB_TOKEN || BLOB_STORE_ID);

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const REDIS_AVAILABLE = Boolean(REDIS_URL && REDIS_TOKEN);

const FORCED_DRIVER = (process.env.STORAGE_DRIVER || '').trim().toLowerCase();

// ===========================================================================
// Vercel Blob driver
// ===========================================================================
let _blobLib = null;
function blobLib() {
  if (!_blobLib) _blobLib = require('@vercel/blob'); // lazy — only if selected
  return _blobLib;
}
const blobPath = (roomId) => 'rooms/' + roomId + '.json';

const blobDriver = {
  async loadRoom(roomId) {
    const { get } = blobLib();
    let result;
    try {
      // useCache:false → always read the latest write (Blob CDN is eventually
      // consistent for up to 60s otherwise, which would show stale votes).
      result = await get(blobPath(roomId), { access: BLOB_ACCESS, useCache: false });
    } catch (err) {
      // get() returns null when missing, but be defensive about not-found errors.
      if (err && /not.?found/i.test(err.message || '')) return null;
      throw err;
    }
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    const text = await new Response(result.stream).text();
    if (!text) return null;
    return JSON.parse(text);
  },
  async saveRoom(roomId, room) {
    const { put } = blobLib();
    await put(blobPath(roomId), JSON.stringify(room), {
      access: BLOB_ACCESS,
      allowOverwrite: true, // reuse the same pathname per room
      contentType: 'application/json',
      cacheControlMaxAge: 60, // minimum allowed; reads bypass it via useCache:false
    });
  },
  async deleteRoom(roomId) {
    const { del } = blobLib();
    await del(blobPath(roomId)); // no-op if it doesn't exist
  },
};

// ===========================================================================
// Upstash Redis driver
// ===========================================================================
let _redis = null;
function redisClient() {
  if (!_redis) {
    const { Redis } = require('@upstash/redis'); // lazy — only if selected
    _redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
  }
  return _redis;
}
const redisKey = (roomId) => 'pp:room:' + roomId;

const redisDriver = {
  async loadRoom(roomId) {
    const room = await redisClient().get(redisKey(roomId)); // auto-deserialized JSON
    return room || null;
  },
  async saveRoom(roomId, room) {
    await redisClient().set(redisKey(roomId), room, { ex: ROOM_TTL_SECONDS });
  },
  async deleteRoom(roomId) {
    await redisClient().del(redisKey(roomId));
  },
};

// ===========================================================================
// Driver selection
// ===========================================================================
function pickDriver() {
  if (FORCED_DRIVER === 'blob') return BLOB_AVAILABLE ? blobDriver : null;
  if (FORCED_DRIVER === 'redis') return REDIS_AVAILABLE ? redisDriver : null;
  if (BLOB_AVAILABLE) return blobDriver; // auto: prefer whichever is connected
  if (REDIS_AVAILABLE) return redisDriver;
  return null;
}

function driver() {
  const d = pickDriver();
  if (!d) {
    const e = new Error(
      'Storage not configured. Connect a Vercel Blob store (sets ' +
        'BLOB_READ_WRITE_TOKEN / BLOB_STORE_ID) or an Upstash Redis / Vercel KV ' +
        'store (sets UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN, or the ' +
        'KV_REST_API_* pair), then redeploy.'
    );
    e.code = 'NO_STORAGE';
    throw e;
  }
  return d;
}

// Thin persistence facade used by the logic below.
const loadRoom = (roomId) => driver().loadRoom(roomId);
const saveRoom = (roomId, room) => driver().saveRoom(roomId, room);
const deleteRoom = (roomId) => driver().deleteRoom(roomId);

// ===========================================================================
// Pure helpers (no I/O)
// ===========================================================================

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

// ===========================================================================
// Read path (polling)
// ===========================================================================

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

// ===========================================================================
// Write path (mutations)
//
// Each mutation loads the room, applies an in-place mutator, prunes, and saves.
// Every mutation returns { ok, error?, state } so the API handler responds with
// the fresh view in a single round trip (no extra read).
// ===========================================================================

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
