# 100 DAYS OUTRUN — Highway Survival

A **3D multiplayer** post-apocalyptic road-survival run. One rig, one hundred days, and a highway that
throws scavengers, raider cars, acid rain and Category 5 hypercanes at you the whole way.

Built with Three.js, ships with **zero runtime dependencies**, runs on a plain Node server or on **Vercel**.

![style](https://img.shields.io/badge/engine-Three.js%20r169-ff8a1e) ![style](https://img.shields.io/badge/multiplayer-WebSocket%20%2B%20HTTP%20fallback-5ff0ff) ![style](https://img.shields.io/badge/deploy-Vercel-black)

---

## ▶ Play

```bash
npm start          # http://localhost:8000
```

No install step, no build step, no dependencies — `public/vendor/three.module.js` is vendored so the game
even boots with the network unplugged.

## 🎮 Controls

| Input | On foot | In the rig |
| --- | --- | --- |
| `W A S D` / arrows | Walk (camera-relative) | Throttle / brake / steer |
| `Shift` | Sprint | Nitro boost (burns fuel fast) |
| `Space` | Jump | **Deploy / release anchor spikes** |
| `E` | Enter the rig (within 6 m) | Bail out (under 15 km/h) |
| `F` / click | Melee or shoot the equipped weapon | Horn |
| `G` | Scavenge the pit-stop you're standing at | Scavenge from the driver's seat |
| `Tab` | Mobile workbench (craft / repair) | same |
| `Enter` | Chat — everyone in the room sees it | same |
| Drag / wheel | Orbit + zoom the camera | same |

Touch devices get a virtual stick, plus ENTER/EXIT and ATTACK buttons automatically.

## 🧍 Your survivor, your rig

You are not a floating camera. Every player is a full blocky **Roblox-style humanoid** — head, torso,
arms, legs, hand-held weapon, name tag — that walks, sprints, swings a bat and can be seen driving or
running around by everyone else in the room. Pick body and rig colours in the lobby and the preview
updates live (drag it to spin).

## 🚗 The 100-day loop

* **Day 1 — Oakhaven Outskirts.** You spawn in the driver's seat with 20 L in the tank.
* **95 seconds = 1 day.** Each day rolls new weather; every 20 days the world changes biome.
* **5 zones:** Outskirts → Sunken Highway → Industrial Wastes → Desert Canyons → Final Mile.
* **Milestones** at days 7, 15, 20, 30, 40, 45, 55, 65, 70, 78, 85, 90, 95 and 100 — boss rigs, workbench
  unlocks and the Category 5 Hypercane finale (survive 2 minutes in it to win).
* **Pit-stops** every ~240 m: gas stations, diners, motels, military checkpoints, wreck yards. Scavenge for
  scrap, steel, titanium, high-carbon steel, leather, chemicals and rare sword cores; gas stops refill fuel.
* **Weather:** dust storms, EMP thunderstorms, acid rain (eats hull and blades), heatwaves, gale winds,
  and drifting **tornadoes (Cat 1–5)** that pull and lift anything not anchored.

## ⚓ Anchors and tornado physics

Tornadoes scan a **350 m** zone and apply a radial pull + upward lift vector that scales with category.
Unanchored, your rig slides, takes chassis/tire damage and gets tossed. Slow below 45 km/h and hit
`Space` — four spikes bite the asphalt, the pull vector is negated, and the storm banner flips to
**ANCHORS HOLDING**. Upgrade spikes (tiers 1–4) for deeper hold, and weld on armor plating to blunt impacts.

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
Weapons wear out with use — repair or craft a replacement.

## 👥 Multiplayer

Share a **room code** (lobby field, or `?room=` in the URL). Everyone in the room shares the highway:
positions, driving/walking state, health, weapon and chat are relayed ~11×/s.

Three transport lanes, all speaking one JSON envelope:

1. **WebSocket** relay in `server.mjs` (zero dependencies, hand-rolled RFC 6455) — best latency, used on
   `npm start` or any Node host.
2. **HTTP polling** via `POST /api/room` — automatic fallback, and what keeps online play working on
   Vercel's serverless runtime.
3. **BroadcastChannel** — always on, so two tabs on the same machine see each other instantly.

Point the client at a remote relay with `?relay=wss://your-relay.example/ws` — useful when you host the
frontend statically (Vercel) and the relay separately.

## ▲ Deploy to Vercel

```bash
npm i -g vercel
vercel            # framework preset: Other
```

`vercel.json` already sets `buildCommand: npm run build` (copies `public/` → `dist/`) and ships the two
serverless endpoints. The game and lobby are fully playable on Vercel; online play uses the polling lane
(distributed serverless lambdas are best-effort — for guaranteed low-latency sessions, host `server.mjs`
on a Node box and pass `?relay=`).

## 🗂 Project layout

```
public/
  index.html          lobby, HUD, workbench, game-over screens
  styles.css          neon/CRT UI, radar, responsive + touch layout
  vendor/three.module.js
  js/main.js          lobby wiring, avatar preview, boot
  js/game.js          run state, day cycle, crafting, combat, camera, sync
  js/world.js         infinite highway, biomes, props, pit-stops, weather FX
  js/vehicle.js       rig mesh + arcade driving physics + anchors + damage
  js/avatar.js        blocky survivor rig, face, name tag, weapons, walk cycle
  js/enemies.js       hollows, raider cars, boss rig
  js/tornado.js       funnel visuals, swirl debris, pull/lift force field
  js/net.js           multi-transport multiplayer client
  js/hud.js           HUD, radar scope, workbench UI, chat, toasts
  js/effects.js       pooled particle bursts
  js/audio.js         procedural WebAudio engine/wind/impacts
api/                  Vercel functions: /api/room (relay), /api/health
server.mjs            local static + WebSocket + polling relay
scripts/build.mjs     dist builder
docs/DESIGN.md        game design document
```

## Legacy 2D build

The first iteration of this project — a single-file, top-down canvas version — is preserved untouched in
`legacy/index-2d.html` (with its original design doc at `docs/GDD-legacy-2d.md`). Open it directly in a
browser if you want to see where the highway started.

## Notes

* Rendering: WebGL2, PCF soft shadows, ACES tone mapping, object recycling for an endless road.
* The whole simulation was smoke-tested headless (12k+ frames of fuzzed input, day 1→100, crafting all
  recipes, tornado anchoring, death/respawn/win) before shipping.
* License: Apache-2.0 (see `LICENSE`).

Stay on the asphalt. The wind does not care.
