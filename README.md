# Planning Poker

A Planning Poker (scrum estimation) web app. It ships in **two forms** that
share the same UI (`public/`):

- **Vercel (serverless):** the client polls `GET /api/state` and posts moves to
  `POST /api/action`. Room state lives in **Upstash Redis** so it can be shared
  across serverless functions and survive cold starts. This is the default
  deploy target — see below.
- **Persistent host (Render / Fly):** the original `server.js` uses Express +
  Socket.IO (WebSockets) with in-memory state. Used for local dev and any
  always-on host. `server.js` is excluded from the Vercel build via
  `.vercelignore`.

## Local development

```bash
npm install
npm start
```

Open http://localhost:3000

This runs the Socket.IO server (`server.js`) with in-memory state — no Redis
required for local dev. It listens on `process.env.PORT || 3000` at host
`0.0.0.0`.

---

## Deploy to Vercel (primary)

The `api/` functions are stateless; all room state lives in an external store.
**Two backends are supported and auto-detected** — connect *either* one in your
Vercel project and it just works (no code change):

| Backend | Env vars it sets | Notes |
|---|---|---|
| **Upstash Redis / Vercel KV** (recommended) | `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`, or `KV_REST_API_URL` + `KV_REST_API_TOKEN` | Fast (~10-50ms), supports TTL (idle rooms auto-expire in 6h). |
| **Vercel Blob** | `BLOB_READ_WRITE_TOKEN` and/or `BLOB_STORE_ID` | Works, but slower (each poll is a consistent object read) and has **no TTL** — abandoned room blobs persist until removed. |

The store prefers Blob if a Blob store is connected, else Redis. Force one with
`STORAGE_DRIVER=blob` or `STORAGE_DRIVER=redis`.

### Option A — Redis (recommended)

In your Vercel project: **Storage** → **Create Database** → **Upstash Redis**
(Marketplace) → connect it to this project. Vercel injects the credentials
automatically.

### Option B — Vercel Blob

In your Vercel project: **Storage** → **Create Database** → **Blob** → set access
to **Private** → connect it to this project. Vercel injects `BLOB_READ_WRITE_TOKEN`
/ `BLOB_STORE_ID` automatically. (For a public store, also set
`BLOB_ACCESS=public`; private is the default and recommended.)

### Then

1. **Redeploy** so the functions pick up the new env vars (env vars only load at
   deploy time):

   ```bash
   npx vercel --prod
   ```

   Or, if the GitHub repo is connected, use **Deployments → ⋯ → Redeploy**.

2. Open the deployment URL and share the invite link (includes `?room=...`).

### Notes

- If no store is connected, the API returns **503** with a clear message
  ("Storage not configured…") instead of a generic crash.
- Players who stop polling for 30s are pruned from their room. With Redis, idle
  rooms also auto-expire after 6h; with Blob there is no TTL.
- There are **no WebSockets** on Vercel — the client polls every 1.5s, which is
  fine for small estimation groups.

---

## Deploy to Fly.io (primary)

Fly.io runs the app in a Docker container using the included `Dockerfile`
and `fly.toml`. WebSockets work transparently over Fly's `http_service`.

1. Install the Fly CLI: https://fly.io/docs/hands-on/install-flyctl/
2. Log in (interactive — you must run this yourself):

   ```bash
   fly auth login
   ```

3. Launch the app. This reads the existing `fly.toml` (`--copy-config`)
   instead of generating a new one, and skips the first deploy so you can
   review the config:

   ```bash
   fly launch --no-deploy --copy-config --name <name>
   ```

   Replace `<name>` with a unique app name if `planning-poker` is already
   taken (Fly app names are globally unique). Update the `app` field in
   `fly.toml` to match if it changes.

4. Deploy:

   ```bash
   fly deploy
   ```

5. Your app will be live at:

   ```
   https://<app-name>.fly.dev
   ```

   (using the free-tier shared public domain).

### Notes

- `fly.toml` is configured with `auto_stop_machines = "stop"` and
  `min_machines_running = 0`, so the machine scales to zero when idle and
  starts back up on the next request (cold start delay is normal).
- Health checks hit `GET /healthz` — make sure `server.js` responds `200`
  on that route.
- To see logs: `fly logs`. To check status: `fly status`.

---

## Deploy to Render.com (fallback)

Render can deploy directly from `render.yaml` (a "Blueprint").

1. Push this repo to GitHub/GitLab.
2. In the Render dashboard: **New +** -> **Blueprint** -> select this repo.
   Render will detect `render.yaml` automatically.
3. Confirm the plan (`free`) and region (`oregon`), then **Apply**.

This creates one web service:
- Build command: `npm install`
- Start command: `node server.js`
- Health check path: `/healthz`

Render's free web services support WebSockets natively, so Socket.IO works
without extra configuration. Note that free-tier services on Render spin
down after inactivity and take ~30-60s to wake on the next request.

Your app will be live at the URL shown on the service page
(e.g. `https://planning-poker.onrender.com`).

---

## Files in this repo

| File | Purpose |
|---|---|
| `Dockerfile` | Container build for Fly.io (and any Docker host) |
| `.dockerignore` | Keeps the image lean |
| `fly.toml` | Fly.io app config (region, health checks, VM size, scale-to-zero) |
| `render.yaml` | Render Blueprint (Node-native deploy, no Docker required) |
| `.gitignore` | Keeps `node_modules`, `.env`, logs out of git |
