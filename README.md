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

The `api/` functions are stateless; all room state is stored in Upstash Redis.
You need a free Upstash database and its two REST credentials.

1. **Create a free Redis database.** Easiest path — in your Vercel project:
   **Storage** → **Create Database** → **Upstash Redis** (Marketplace). Vercel
   auto-injects `KV_REST_API_URL` and `KV_REST_API_TOKEN` (or the
   `UPSTASH_REDIS_REST_*` pair) into the project. The store reads either name
   pair, so no code change is needed.

   Alternatively, sign up at https://upstash.com, create a Redis database, copy
   its **REST URL** and **REST TOKEN**, and add them as Vercel environment
   variables named `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.

2. **Deploy** (from the project root):

   ```bash
   npx vercel        # preview
   npx vercel --prod # production
   ```

   Or connect the GitHub repo in the Vercel dashboard and it deploys on push.

3. Open the deployment URL. Share the invite link (includes `?room=...`) with
   your team.

### Notes

- If the env vars are missing, the API returns **503** with a clear message
  ("Storage not configured…") instead of a generic crash.
- State auto-expires: idle rooms are removed after 6 hours (Redis TTL), and
  players who stop polling for 30s are pruned from their room.
- There are **no WebSockets** on Vercel — the client polls every 1.5s, which is
  well within the free tier for small estimation groups.

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
