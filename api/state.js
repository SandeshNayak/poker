'use strict';

/**
 * GET /api/state?roomId=...&playerId=...
 *
 * Polling endpoint used by the client to read the latest room state.
 * `playerId` is optional — when present we "touch" that player's
 * lastSeen so they aren't pruned as stale while they're actively polling.
 */

const store = require('../lib/store');

module.exports = (req, res) => {
  // Always return fresh data; this is a polling endpoint.
  res.setHeader('Cache-Control', 'no-store');

  const { roomId, playerId } = req.query || {};

  if (!roomId) {
    res.status(400).json({ error: 'roomId required' });
    return;
  }

  // touch() is a safe no-op when playerId is undefined or unknown.
  store.touch(roomId, playerId);

  res.status(200).json(store.publicState(roomId));
};
