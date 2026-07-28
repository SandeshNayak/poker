'use strict';

/**
 * Local / persistent-host entrypoint for Planning Poker.
 *
 * This is intentionally a thin wrapper: it serves the static frontend from
 * ./public and mounts the SAME serverless handlers used on Vercel
 * (api/state.js and api/action.js) as plain Express routes. Running the exact
 * same request handlers locally means there is no logic drift between local
 * dev and the deployed app.
 *
 * STORAGE: a single long-lived Node process can share state in memory across
 * requests, so if no external store is configured we default the store to its
 * in-memory driver. That keeps `npm start` zero-config (no Redis/Blob needed).
 * If you DO set Blob/Redis env vars, those are used instead.
 *
 * NOTE: the in-memory default only works because this is one persistent
 * process. On Vercel each function is isolated, which is why the deployed app
 * requires an external store (see README).
 */

// Default local dev to the in-memory store unless the operator explicitly
// configured a backend. Must run before requiring the handlers (which require
// lib/store.js, where the driver is selected from env at load time).
if (
  !process.env.STORAGE_DRIVER &&
  !process.env.BLOB_READ_WRITE_TOKEN &&
  !process.env.BLOB_STORE_ID &&
  !process.env.UPSTASH_REDIS_REST_URL &&
  !process.env.KV_REST_API_URL
) {
  process.env.STORAGE_DRIVER = 'memory';
}

const path = require('path');
const express = require('express');

const stateHandler = require('./api/state');
const actionHandler = require('./api/action');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// Parse JSON bodies so req.body is populated for the action handler
// (mirrors Vercel's automatic body parsing).
app.use(express.json());

// Serve the frontend from the public/ directory.
app.use(express.static(path.join(__dirname, 'public')));

// Liveness endpoint for load balancers / uptime checks.
app.get('/healthz', (req, res) => {
  res.status(200).send('ok');
});

// The same handlers Vercel runs as serverless functions.
app.get('/api/state', (req, res) => stateHandler(req, res));
app.post('/api/action', (req, res) => actionHandler(req, res));

const server = app.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`Planning Poker server listening on http://localhost:${PORT}`);
  console.log(`Storage driver: ${process.env.STORAGE_DRIVER || 'auto'}`);
});

module.exports = { app, server };
