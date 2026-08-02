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
// Prune a player who hasn't polled/acted within this window. Kept generous
// because browsers THROTTLE background-tab timers (setInterval can drop to once
// per minute when a tab is hidden), so a short window would spuriously drop
// participants whose tab is simply in the background. The client also self-heals
// via re-join, but a forgiving window avoids the churn (and host reshuffles)
// in the first place.
const STALE_MS = 120000; // 2 minutes
const TOUCH_WRITE_MS = 8000; // only rewrite lastSeen if older than this (limits writes)
// Emoji reactions are ephemeral. They live in room state for a short window so
// the polling clients (default 1.5s interval) reliably catch each one, then
// age out. Capped so a spammer can't grow the stored room unbounded.
const REACTION_TTL_MS = 6000;
const MAX_REACTIONS = 40;
// Chat persists for the session (no TTL) but is capped so the stored room
// can't grow without bound. Older messages fall off the top.
const MAX_CHAT = 100;
const MAX_CHAT_LEN = 300;

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
// In-memory driver (LOCAL DEV ONLY)
//
// A single Node process (e.g. `npm start` running server.js, or a single
// Render/Fly instance) can share a module-level object across requests. This
// is NOT usable on Vercel, where each function invocation is isolated — hence
// it is only selected when STORAGE_DRIVER=memory is set explicitly (server.js
// does this automatically when no external store is configured).
// ===========================================================================
const _mem = new Map();
const memoryDriver = {
  async loadRoom(roomId) {
    const raw = _mem.get(roomId);
    // Parse a copy so callers can't mutate stored state in place — mirrors the
    // serialize/deserialize boundary the Blob and Redis drivers have.
    return raw ? JSON.parse(raw) : null;
  },
  async saveRoom(roomId, room) {
    _mem.set(roomId, JSON.stringify(room));
  },
  async deleteRoom(roomId) {
    _mem.delete(roomId);
  },
};

// ===========================================================================
// Driver selection
// ===========================================================================
function pickDriver() {
  if (FORCED_DRIVER === 'memory') return memoryDriver;
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
    ownerId: null, // the original creator — host role resolves back to them
    hostId: null,
    roundCount: 0,
    players: {},
    history: [],
    reactions: [], // ephemeral emoji reactions; see REACTION_TTL_MS
    chat: [], // live chat messages; capped at MAX_CHAT
  };
}

/**
 * Decide who holds the host role. The room OWNER (creator) is host whenever
 * they are present, so a host who refreshes or whose tab was briefly
 * backgrounded reclaims host instead of being permanently swapped out. Only
 * when the owner is genuinely gone (pruned) does the role fall to another
 * present player. Returns true if hostId changed.
 */
function resolveHost(room) {
  const ids = Object.keys(room.players);
  const before = room.hostId;

  if (ids.length === 0) {
    room.hostId = null;
  } else if (room.ownerId && room.players[room.ownerId]) {
    // Owner present → they are host.
    room.hostId = room.ownerId;
  } else if (!room.hostId || !room.players[room.hostId]) {
    // Owner absent and current host invalid → hand off to a present player.
    room.hostId = ids[0];
  }

  return room.hostId !== before;
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

  // Host role always resolves back to the present owner (see resolveHost),
  // so a host who briefly dropped out reclaims the role rather than being
  // permanently replaced.
  if (resolveHost(room)) changed = true;
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

/** Drop expired reactions in place. Returns true if any were removed. */
function pruneReactions(room) {
  if (!Array.isArray(room.reactions) || room.reactions.length === 0) return false;
  const cutoff = Date.now() - REACTION_TTL_MS;
  const before = room.reactions.length;
  room.reactions = room.reactions.filter((r) => r.at > cutoff);
  return room.reactions.length !== before;
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

  // Only surface reactions still within their TTL so late-polling clients don't
  // replay stale bursts (the array itself is pruned lazily on the write path).
  const cutoff = Date.now() - REACTION_TTL_MS;
  const reactions = Array.isArray(room.reactions)
    ? room.reactions.filter((r) => r.at > cutoff)
    : [];

  return {
    roomId,
    topic: room.topic,
    revealed: room.revealed,
    players,
    stats: computeStats(room.players),
    hostId: room.hostId,
    history: room.history,
    reactions,
    chat: Array.isArray(room.chat) ? room.chat : [],
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
  if (pruneReactions(room)) changed = true;

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
  pruneReactions(room);

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
    // Claim ownership only for a genuinely leaderless room: no owner AND no
    // valid current host. This makes the first player into a fresh room the
    // permanent owner (host resolves back to them on any refresh/transient
    // drop — see resolveHost), while ensuring a returning ex-owner does NOT
    // leapfrog whoever is currently hosting an owner-less room.
    if (!room.ownerId && (!room.hostId || !room.players[room.hostId])) {
      room.ownerId = playerId;
    }
    resolveHost(room);
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

// Reactions are cosmetic, so the allow-list is the guard: it keeps the stored
// payload tiny and bounded and stops arbitrary strings (or markup) from being
// echoed back to every client through the emoji channel.
const ALLOWED_REACTIONS = ['👍', '👎', '🎉', '😂', '🤔', '❤️', '🔥', '👏', '😮', '🚀'];

function react(roomId, playerId, emoji) {
  return withRoom(roomId, {}, (room) => {
    const player = room.players[playerId];
    if (!player) return { ok: false, error: 'You are not in this room.' };
    if (ALLOWED_REACTIONS.indexOf(emoji) === -1) {
      return { ok: false, error: 'Unknown reaction.' };
    }
    if (!Array.isArray(room.reactions)) room.reactions = [];
    const now = Date.now();
    room.reactions.push({
      // id lets clients animate each reaction exactly once across polls.
      id: playerId + ':' + now + ':' + Math.round(Math.random() * 1e6),
      emoji,
      by: player.name,
      at: now,
    });
    // Keep only the most recent burst so the room can't grow unbounded.
    if (room.reactions.length > MAX_REACTIONS) {
      room.reactions = room.reactions.slice(-MAX_REACTIONS);
    }
    player.lastSeen = now;
    return { ok: true };
  });
}

function sendChat(roomId, playerId, text) {
  return withRoom(roomId, {}, (room) => {
    const player = room.players[playerId];
    if (!player) return { ok: false, error: 'You are not in this room.' };
    if (typeof text !== 'string') return { ok: false, error: 'Message must be text.' };
    const trimmed = text.trim().slice(0, MAX_CHAT_LEN);
    if (!trimmed) return { ok: false, error: 'Message is empty.' };
    if (!Array.isArray(room.chat)) room.chat = [];
    const now = Date.now();
    room.chat.push({
      // id lets clients append only new messages (no full re-render per poll).
      id: playerId + ':' + now + ':' + Math.round(Math.random() * 1e6),
      by: player.name,
      byId: playerId,
      text: trimmed,
      at: now,
    });
    // Cap the log; oldest messages fall off the top.
    if (room.chat.length > MAX_CHAT) {
      room.chat = room.chat.slice(-MAX_CHAT);
    }
    player.lastSeen = now;
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
      return { ok: false, error: 'Only the host can reset the round.' };
    }
    // Reset re-opens the SAME round: clear votes and hide cards, but keep the
    // topic/note so the team can re-vote the same item.
    room.revealed = false;
    for (const p of Object.values(room.players)) p.vote = null;
    return { ok: true };
  });
}

function newRound(roomId, playerId) {
  return withRoom(roomId, {}, (room) => {
    if (playerId !== room.hostId) {
      return { ok: false, error: 'Only the host can start a new round.' };
    }
    // New round starts a FRESH item: clear votes, hide cards, AND clear the
    // topic/note so the team can estimate the next story.
    room.revealed = false;
    room.topic = '';
    for (const p of Object.values(room.players)) p.vote = null;
    return { ok: true };
  });
}

function clearHistory(roomId, playerId) {
  return withRoom(roomId, {}, (room) => {
    if (playerId !== room.hostId) {
      return { ok: false, error: 'Only the host can clear the round history.' };
    }
    // Wipe past revealed rounds and restart round numbering. Does NOT touch the
    // current round's votes/topic — it only clears the history log.
    room.history = [];
    room.roundCount = 0;
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

/**
 * Hand the host role to another present player. Only the current host may do
 * this. We move BOTH hostId and ownerId to the target: ownerId is the anchor
 * resolveHost() snaps back to, so without moving it the transfer would be
 * undone on the next prune/refresh. The new owner is now the stable host.
 */
function transferHost(roomId, playerId, targetId) {
  return withRoom(roomId, {}, (room) => {
    if (playerId !== room.hostId) {
      return { ok: false, error: 'Only the host can transfer the host role.' };
    }
    if (!targetId || !room.players[targetId]) {
      return { ok: false, error: 'That player is no longer in the room.' };
    }
    if (targetId === room.hostId) {
      return { ok: false, error: 'They are already the host.' };
    }
    room.ownerId = targetId;
    room.hostId = targetId;
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
    // An explicit leave (not a transient drop) relinquishes ownership, so the
    // host role can move on rather than waiting for a never-returning owner.
    if (playerId === room.ownerId) room.ownerId = null;
    resolveHost(room);
    return { ok: true };
  });
}

module.exports = {
  computeStats,
  getState,
  join,
  vote,
  react,
  sendChat,
  reveal,
  reset,
  newRound,
  clearHistory,
  setTopic,
  changeName,
  transferHost,
  leave,
};
