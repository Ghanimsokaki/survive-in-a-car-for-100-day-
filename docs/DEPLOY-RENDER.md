# Deploying the room server on Render (free tier)

`server.js` is the Socket.IO host: rooms of **1–8**, matchmaking codes, 15 Hz vehicle telemetry. Vercel keeps
serving the front-end; Render runs the sockets, because serverless functions cannot hold a WebSocket open.

Everything below can be done from a phone browser.

## 1. One-click blueprint (or manually, it is four fields)

`render.yaml` in the repo root already describes the service, so on Render: **New → Blueprint** → pick this
repository → **Apply**. If you prefer the manual route:

| Field | Value |
| --- | --- |
| Environment | **Node** |
| Build command | `npm install` |
| Start command | `npm start` |
| Health check path | `/health` |
| Region | whichever is closest to your players (`singapore` for South-East Asia) |

Nothing else is required — the server reads the port Render gives it:

```js
const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0';
```

## 2. CORS — open, or yours to close

CORS is **open by default**: any front-end (the Vercel deploy, a custom domain, a preview branch, a local
file) can call the API and open a socket. That is deliberate — this relay holds no cookies and no secrets.

To restrict it instead, set `ALLOWED_ORIGINS` (a list is the opt-in) or `CORS=strict` for the built-in
production list:

```text
ALLOWED_ORIGINS = https://gemby-game.vercel.app,https://*.vercel.app
```

Wildcards are matched on the parsed host, so `gemby-game.vercel.app.evil.com` is refused.
`https://your-service.onrender.com/health` reports `cors: {open, mode, origins}` — the exact policy in force.

Optional, for accounts and the Supabase realtime fallback:

```text
SUPABASE_URL       = https://xxxxxxxx.supabase.co
SUPABASE_ANON_KEY  = eyJ…
```

## 3. Keeping the free container awake

Free web services sleep after ~15 idle minutes. `server.js` therefore pings **itself**: every 10 minutes it
sends one GET request to its own public URL (`/health`), from inside, using node's native `https` client.

* The URL is `RENDER_EXTERNAL_URL`, which Render injects automatically — no setup.
* The first ping lands a few seconds after boot (so the log tells you immediately whether the URL is right),
  then every ten minutes.
* Nothing stacks: a ping that is still in flight is not doubled, and a timeout (15 s) is counted, not thrown.

Check it is working — open `/health` on the service and look at the bottom:

```json
"keepalive": {
  "enabled": true,
  "url": "https://gemby-game.onrender.com/health",
  "intervalMs": 600000,
  "intervalSeconds": 600,
  "pings": 7,
  "failures": 0,
  "lastStatus": 200,
  "lastAt": 1793365334127,
  "lastMs": 118,
  "lastError": ""
}
```

`pings` climbing every ten minutes and `failures` staying at zero is the whole check.

**What it cannot do.** A container that is already asleep has no process to send the ping, so the first wake of
the day still has to come from outside — and free instances are recycled from time to time regardless. The
interval keeps an *awake* instance awake, which is exactly the idle-sleep problem. If a deploy sits untouched
for hours, open the URL once (that is enough to wake it), or add Render's own cron/uptime check as a backup.

| Variable | Default | Meaning |
| --- | --- | --- |
| `RENDER_EXTERNAL_URL` | set by Render | the URL to ping |
| `PUBLIC_URL` / `SELF_URL` / `KEEPALIVE_URL` | — | manual override on any host |
| `KEEPALIVE` | `1` | `0` disables the loop |
| `KEEPALIVE_MINUTES` | `10` | interval |
| `KEEPALIVE_PATH` | `/health` | what to request |

## 4. Point the game at it

Either open the game with the relay in the URL:

```text
https://gemby-game.vercel.app/?relay=https://gemby-game.onrender.com
```

…or set it once for the whole deployment, in `index.html` of the build, or via Vercel's env if you inject
config:

```html
<script>window.__OUTRUN_RELAY__ = 'https://gemby-game.onrender.com';</script>
```

The client probes `/health`, sees `"engine": "socket.io"`, and the HUD reads **SOCKET.IO**. If Render is asleep
or unreachable, the next lane (Supabase Realtime) takes over without an error screen — the player never sees a
dead lobby.

## 5. Sanity checks

```bash
curl https://your-service.onrender.com/health          # engine, rooms, cors, keepalive
curl https://your-service.onrender.com/api/rooms       # public rooms, no player ids
curl -I https://your-service.onrender.com/socket.io/   # 200 or 400 — the socket endpoint is alive
```

From a phone: open the game with `?relay=…`, start a run, and the HUD badge should say `SOCKET.IO` within a
second or two. Two phones in the same room code should see each other's rig immediately.
