# 100 DAYS OUTRUN — Highway Survival

A **3D multiplayer** post-apocalyptic road-survival run. One rig, one hundred days, and a highway that
throws scavengers, raider cars, acid rain and Category 5 hypercanes at you the whole way.

Roblox-style **username + password sign-in**, a **friends list with live presence**, full **phone support**,
and a game that runs on a plain Node server or on **Vercel** — with zero runtime dependencies.

![engine](https://img.shields.io/badge/engine-Three.js%20r169-ff8a1e) ![accounts](https://img.shields.io/badge/accounts-Supabase-3ecf8e) ![multiplayer](https://img.shields.io/badge/multiplayer-WebSocket%20%2B%20HTTP%20fallback-5ff0ff) ![mobile](https://img.shields.io/badge/phones-touch%20ready-5ff0ff) ![deploy](https://img.shields.io/badge/deploy-Vercel-black)

---

## ▶ Play

```bash
npm start          # http://localhost:8000
npm test           # headless suites (simulation, accounts, both UI flows)
```

No install step, no build step. `public/vendor/three.module.js` is vendored, so the game boots even offline.

## 👤 Sign in like Roblox

The first screen is an account screen:

* **Username + password**, with a **LOG IN / SIGN UP** switch — accounts live in **Supabase**.
* Sign-up also picks a **display name**, body colour and rig colour, and those follow you to every device.
* **PLAY AS GUEST** if you just want to drive (friends and cross-device saves stay off).
* First load with no backend starts in guest mode and says so — nothing breaks.

### Connect Supabase (2 minutes)

1. Create a project at [supabase.com](https://supabase.com).
2. **SQL Editor → New query** → paste `supabase/schema.sql` → **Run**.
   This creates `profiles`, `friendships`, `presence`, the row-level-security policies and the
   `add_friend` / `remove_friend` helper functions.
3. **Authentication → Providers → Email → turn OFF “Confirm email”** (usernames map to
   `<username>@players.outrun.local`, so confirmation mail can never arrive).
4. Copy **Project URL** + **anon public key** from *Project Settings → API* into `.env`:

```bash
cp .env.example .env
# SUPABASE_URL=https://xxxx.supabase.co
# SUPABASE_ANON_KEY=eyJhbGciOi...
npm start
```

On a static host (Vercel, Netlify, GitHub Pages) there is no server to read `.env`, so either set the same
two variables in the host's environment (Vercel does this through `api/config.js`), or tap
**CONNECT SUPABASE** on the sign-in screen and paste the URL + anon key once — it is stored on that device.

The anon key is safe to expose; it can only do what the RLS policies allow.

## 👥 Friends

Once signed in, the lobby shows a friends panel:

* Add a survivor **by username**; friendships are two-way and written by a security-definer RPC.
* Each friend shows **ONLINE / OFFLINE**, and if they are playing: their **room code and day**.
* **JOIN** drops their room code into your lobby — press *START THE RUN* and you are on their highway.
* Remove with ✕. Presence beats every 20 s and friends auto-refresh every 25 s, so the list stays honest.
* Best run (`best_day`) is stored per account and kept across devices.

Guests still get the shared highway and chat — they just have no persistent friends list.

## 📱 Phones

The whole game is phone-first:

* **Left thumb = virtual stick** (steer/throttle/brake, push to the edge to boost). **Right side = look**
  drag; **pinch** to zoom the camera.
* Big 48 px action cluster: anchor, workbench, scavenge, enter/exit rig, attack.
* No pinch-to-zoom-page, no scroll, no iOS zoom-on-focus, safe-area insets on notched screens.
* **Rotate hint** in portrait, and a ☰ in-game menu (tap twice) to leave the run.
* Automatic quality tier: low-end phones drop shadows, pixel ratio and particle/prop budgets; the workbench
  becomes a full-screen sheet and the HUD scales to fit.

| Input | On foot | In the rig |
| --- | --- | --- |
| `W A S D` / stick | Walk (camera-relative) | Throttle / brake / steer |
| `Shift` / full stick | Sprint | Nitro boost (burns fuel fast) |
| `Space` / ⚓ | Jump | **Deploy / release anchor spikes** |
| `E` / 🚪 | Enter the rig (within 6 m) | Bail out (under 15 km/h) |
| `F` / 🔪 / tap | Melee or shoot | Horn |
| `G` | Scavenge the pit-stop you're at | Scavenge from the driver's seat |
| `Tab` | Mobile workbench (craft / repair) | same |
| `Enter` | Chat — everyone in the room sees it | same |
| Drag / wheel / pinch | Orbit + zoom the camera | same |

## 🧍 Your survivor, your rig

You are not a floating camera. Every player is a full blocky **Roblox-style humanoid** — head, torso,
arms, legs, hand-held weapon, name tag — that walks, sprints, swings a bat and can be seen driving or
running around by everyone else in the room.

## 🚗 The 100-day loop

* **Day 1 — Oakhaven Outskirts.** You spawn in the driver's seat with 20 L in the tank.
* **95 seconds = 1 day.** Each day rolls new weather; every phase changes biome.
* **5 zones:** Outskirts → Sunken Highway → Industrial Wastes → Desert Canyons → Final Mile.
* **Milestones** at days 7, 15, 20, 30, 40, 45, 55, 65, 70, 78, 85, 90, 95 and 100 — boss rigs, workbench
  unlocks and the Category 5 Hypercane finale (survive 2 minutes in it to win).
* **Pit-stops** every ~240 m: gas stations, diners, motels, military checkpoints, wreck yards.
* **Weather:** dust storms, EMP thunderstorms, acid rain (eats hull and blades), heatwaves, gale winds,
  and drifting **tornadoes (Cat 1–5)** that pull and lift anything not anchored.

## ⚓ Anchors and tornado physics

Tornadoes scan a **350 m** zone and apply a radial pull + upward lift vector that scales with category.
Unanchored, your rig slides, takes chassis/tire damage and gets tossed. Slow below 45 km/h and hit
`Space` — four spikes bite the asphalt, the pull vector is negated, and the storm banner flips to
**ANCHORS HOLDING**. Upgrade spikes (tiers 1–4) for a deeper hold, and weld on armor to blunt impacts.

## 🛠 Crafting tree

Mobile workbench, **Tier 1 → 4** (Tier 2 unlocks on day 15, 3 on day 40, 4 on day 78 — or craft the
upgrades early with the right mats).

| Tier | Weapon | Damage | Durability |
| --- | --- | --- | --- |
| 1 | Scrap Pipe Bat | 20 | 80 |
| 2 | Scrap Metal Machete / Scavenged Revolver | 35 / 34 | 100 / 90 |
| 3 | Leaf Spring Katana (28 % crit) | 55 | 180 |
| 4 | Damascus Scrap Broadsword (armour-piercing) | 120 | 350 |

Plus fuel refining, repair kits, tire patches, full overhauls, armor plating ×3 and hydraulic anchor tiers ×4.

## 👥 Multiplayer

Share a **room code**. Everyone in the room shares the highway: positions, driving/walking state, health,
weapon and chat are relayed ~11×/s. Three transport lanes, one JSON envelope:

1. **WebSocket** relay in `server.mjs` (zero dependencies, hand-rolled RFC 6455).
2. **HTTP polling** via `POST /api/room` — automatic fallback, and what keeps online play working on Vercel.
3. **BroadcastChannel** — always on, so two tabs on one machine see each other instantly.

Point the client at a remote relay with `?relay=wss://your-relay.example/ws`.

## ▲ Deploy to Vercel

```bash
vercel            # framework preset: Other
```

`vercel.json` sets `buildCommand: npm run build` (copies `public/` → `dist/`), ships `api/room`,
`api/health` and `api/config`, and disables caching on the API. Add `SUPABASE_URL` and
`SUPABASE_ANON_KEY` in *Project → Settings → Environment Variables*. Online play on Vercel uses the
polling lane; for low-latency WebSocket rooms host `server.mjs` and pass `?relay=`.

## 🗂 Project layout

```
public/
  index.html          sign-in, lobby + friends, HUD, workbench, game over
  styles.css          neon/CRT UI, phone layout, safe areas, touch controls
  js/main.js          auth → lobby → game flow, avatars, friends UI, presence
  js/authui.js        Roblox-style login/signup, Supabase connect panel
  js/account.js       profile, friends, presence, guest fallback
  js/supabase.js      tiny Supabase client (auth + PostgREST + RPC), no SDK
  js/palette.js       body / rig colour palette
  js/game.js          run state, day cycle, crafting, combat, camera, touch
  js/world.js         infinite highway, biomes, props, pit-stops, weather FX
  js/vehicle.js       rig mesh + arcade driving physics + anchors + damage
  js/avatar.js        blocky survivor rig, face, name tag, weapons, walk cycle
  js/enemies.js       hollows, raider cars, boss rig
  js/tornado.js       funnel visuals, swirl debris, pull/lift force field
  js/net.js           multi-transport multiplayer client
  js/hud.js           HUD, radar scope, workbench UI, chat, toasts
  js/effects.js       pooled particle bursts (budgeted per device)
  js/audio.js         procedural WebAudio engine/wind/impacts
api/                  Vercel functions: /api/room, /api/health, /api/config
supabase/schema.sql   tables, RLS policies, friend RPCs, signup trigger
server.mjs            static + WebSocket + polling relay + config endpoint
tests/                headless suites (npm test)
docs/DESIGN.md        game design document
```

## 🧪 Tests

`npm test` copies the browser modules into a shim lane and runs four suites with no browser:

* **simulation** — driving, fuel, anchors vs. tornado drift, bosses, scavenging, every recipe, melee,
  peers, days 1→100, death/respawn/win, 8k-frame input fuzz.
* **accounts + friends** — sign-up/sign-in, duplicate usernames, wrong passwords, profile round-trips,
  two-way friendships, self/unknown/duplicate guards, presence online/offline, removal, sign-out, guest mode.
* **guest UI flow** — real `main.js` boot on a phone-sized viewport: lobby, colours, room codes, touch
  controls, stick input, workbench, run-end hook.
* **signed-in friends UI** — session restore, account chip, friend rows with room/day, JOIN, add/remove
  through the DOM, presence heartbeat, sign-out.

## Legacy 2D build

The first iteration — a single-file, top-down canvas version — is preserved untouched at
`/legacy/index-2d.html` (design doc: `docs/GDD-legacy-2d.md`).

## Notes

* Rendering: WebGL2, PCF shadows, ACES tone mapping, pooled objects for an endless road.
* License: Apache-2.0 (see `LICENSE`).

Stay on the asphalt. The wind does not care.
