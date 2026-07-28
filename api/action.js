'use strict';

/**
 * POST /api/action
 *
 * Single mutation endpoint for the Planning Poker client. Body is JSON:
 *   { type, roomId, playerId, name, isSpectator, value, topic }
 *
 * Regardless of whether the mutation itself succeeds, we respond 200 with
 * the mutation result plus the fresh public state, so the client can
 * re-render (e.g. show a rejection message) without a second round trip.
 */

const store = require('../lib/store');

/** Read and parse a raw request body stream as JSON. */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// Maps action `type` to the store mutation it triggers.
const ACTIONS = {
  join: (roomId, playerId, body) => store.join(roomId, playerId, body.name, body.isSpectator),
  vote: (roomId, playerId, body) => store.vote(roomId, playerId, body.value),
  reveal: (roomId, playerId) => store.reveal(roomId, playerId),
  reset: (roomId, playerId) => store.reset(roomId, playerId),
  setTopic: (roomId, playerId, body) => store.setTopic(roomId, playerId, body.topic),
  changeName: (roomId, playerId, body) => store.changeName(roomId, playerId, body.name),
  leave: (roomId, playerId) => store.leave(roomId, playerId),
};

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    // Vercel usually pre-parses JSON bodies, but be defensive: handle the
    // string, missing, and already-object cases explicitly.
    let body = req.body;
    try {
      if (typeof body === 'string') {
        body = JSON.parse(body);
      } else if (body === undefined || body === null) {
        body = await readJsonBody(req);
      }
    } catch (err) {
      res.status(400).json({ error: 'Invalid JSON body' });
      return;
    }

    const { type, roomId, playerId } = body || {};

    if (!type || !roomId || !playerId) {
      res.status(400).json({ error: 'type, roomId, playerId required' });
      return;
    }

    const action = ACTIONS[type];
    if (!action) {
      res.status(400).json({ error: 'Unknown action type' });
      return;
    }

    const result = action(roomId, playerId, body);

    res.status(200).json({
      ok: result.ok,
      error: result.ok ? undefined : result.error,
      state: store.publicState(roomId),
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};
