# Planning Poker

Realtime Planning Poker app built with Express + Socket.IO. Because it uses
WebSockets, it needs a persistent host — **not** a static site host.

## Local development

```bash
npm install
npm start
```

Open http://localhost:3000

The server listens on `process.env.PORT || 3000` at host `0.0.0.0`.

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
