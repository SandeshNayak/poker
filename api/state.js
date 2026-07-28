'use strict';

/**
 * GET /api/state?roomId=...&playerId=...
 *
 * Polling endpoint used by the client to read the latest room state.
 * `playerId` is optional — when present the store "touches" that player's
 * lastSeen so they aren't pruned as stale while they're actively polling.
 *
 * The store is backed by Upstash Redis (see lib/store.js), so calls are async.
 */

const store = require('../lib/store');

module.exports = async (req, res) => {
  // Always return fresh data; this is a polling endpoint.
  res.setHeader('Cache-Control', 'no-store');

  const { roomId, playerId } = req.query || {};

  if (!roomId) {
    res.status(400).json({ error: 'roomId required' });
    return;
  }

  try {
    const state = await store.getState(roomId, playerId);
    res.status(200).json(state);
  } catch (err) {
    const status = err && err.code === 'NO_STORAGE' ? 503 : 500;
    res.status(status).json({ error: err && err.message ? err.message : 'Internal error' });
  }
};
