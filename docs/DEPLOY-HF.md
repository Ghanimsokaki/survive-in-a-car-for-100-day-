# Deploying the room server on Hugging Face Spaces

The repository root has a `Dockerfile`, and the README carries the Space metadata (`sdk: docker`,
`app_port: 7860`), so a Space builds straight from this repo.

## 1. Create the Space

1. huggingface.co → **New → Space**.
2. **SDK: Docker** → *Blank* template.
3. Hardware: the free CPU tier is plenty for rooms of eight.
4. Link the repository (or push this repo to the Space's git remote).

Nothing to configure in the Space settings: the build command, the start command and the port all come from
the `Dockerfile` and the README front matter.

## 2. Why the port matters

A Space routes traffic to exactly **7860**, and — unlike Render, Railway, Fly or Heroku — it does **not** set
`PORT` for a Docker space. `EXPOSE 7860` in a Dockerfile only documents a port; it does not bind one. So the
server picks its port at runtime (`lib/port.mjs`):

| Situation | Port |
| --- | --- |
| `PORT` is set by the host (Render, Railway, Fly, Heroku, `docker run -e PORT=…`) | that value |
| inside a Space (`SPACE_ID` / `SPACE_HOST` / `SPACE_REPO_NAME` present) | **7860** |
| a laptop, `npm start` | 8080 |

The boot log says which one it chose:

```text
  GEMBY GAMES — realtime server (socket.io)
  → listening on http://0.0.0.0:7860
  → Hugging Face Space: bound to 7860 (the only port the Space routes to)
```

## 3. Optional variables

Add these under **Settings → Variables and secrets**. None are required to start.

| Variable | Why |
| --- | --- |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | accounts, friends, leaderboards, and the realtime fallback lane |
| `ALLOWED_ORIGINS` | only if you want CORS closed to a list (it is open by default) |
| `PUBLIC_URL` | `https://<user>-<space>.hf.space` — lets the server ping itself and stay warm |

## 4. Keeping the Space from sleeping

Free Spaces go to sleep after a stretch without visitors, and a sleeping Space cannot answer a socket. The
server already has the self-ping used on Render (`lib/keepalive.mjs`): set `PUBLIC_URL` to the Space's public
URL and it will GET its own `/health` every ten minutes while it is awake.

```text
PUBLIC_URL = https://your-user-gemby-games.hf.space
```

The honest limit is the same as everywhere: this keeps an *awake* Space awake. A Space that is already asleep
has no process to send the ping — visit the URL (or use an external uptime pinger) to wake it, and it stays up
for as long as the pinger keeps calling.

## 5. Point the game at it

```text
https://gemby-game.vercel.app/?relay=https://your-user-gemby-games.hf.space
```

The client probes `/health`, sees `"engine": "socket.io"`, and the HUD reads **SOCKET.IO**. If the Space is
asleep or unreachable, the next lane (Supabase Realtime) takes over silently.

CORS is open by default, so no allowlist edit is needed for the Space to accept the Vercel front-end.

## 6. Check it

```bash
curl https://your-user-gemby-games.hf.space/health          # engine, rooms, cors, keepalive
curl https://your-user-gemby-games.hf.space/api/rooms       # public rooms, no player ids
curl -I https://your-user-gemby-games.hf.space/socket.io/   # the socket endpoint is alive
```

From a phone: open the game with `?relay=…`, start a run, and the badge should read `SOCKET.IO` within a
second. Two phones on the same room code should see each other's rig immediately.
