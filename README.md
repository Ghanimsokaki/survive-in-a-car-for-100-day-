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

### How the credentials reach the browser

Three delivery paths, tried in order — so Vercel env vars work whether or not functions run:

| Order | Source | When it applies |
| --- | --- | --- |
| 1 | `GET /api/config` | Vercel serverless function or the Node relay, reading the live environment |
| 2 | `GET ./config.json` | baked by `npm run build` from the same env vars (static hosts) |
| 3 | `localStorage` | the URL + key you pasted into **CONNECT SUPABASE** on that device |

A fourth inline fallback (`dist/supabase-config.js`) is injected into the built HTML for hosts that block
JSON fetches. All of them carry only the anon key; a `service_role` / `sb_secret_` key is detected and
**refused** rather than shipped.

**Accepted variable names** (Vercel, Supabase integration, Next.js and Vite all differ):

* URL: `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `VITE_SUPABASE_URL`, `PUBLIC_SUPABASE_URL`,
  `NUXT_PUBLIC_SUPABASE_URL`, `SUPABASE_PROJECT_URL`
* Key: `SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `VITE_SUPABASE_ANON_KEY`,
  `PUBLIC_SUPABASE_ANON_KEY`, `NUXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_PUBLISHABLE_KEY`,
  `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_PUBLIC_KEY`, `SUPABASE_KEY`

Missing pieces are tolerated: with only the key set, the project URL is derived from the key's `ref` claim.

### Checking it worked (from your phone)

Open the game and tap **CONNECT SUPABASE** — the panel prints a live diagnostic:

```
VERCEL / SERVER ENV — URL ✓ · ANON KEY ✓
BUILD CONFIG.JSON ✓
```

`✗` next to a value means that variable was not visible to the deployment (wrong name, saved to the wrong
environment, or not redeployed). When accounts work, the same panel shows
`CONNECTED — credentials from server env (SUPABASE_URL + SUPABASE_ANON_KEY)`.

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
* **Roadside buildings you can walk into** (see below) — houses, stores, garages, barns and more.
* **Weather:** dust storms, EMP thunderstorms, acid rain (eats hull and blades), heatwaves, gale winds,
  and drifting **tornadoes (Cat 1–5)** that pull and lift anything not anchored.

## ⚙️ Graphics setting
The lobby has a **GRAPHICS** switch — `AUTO / LOW / MED / HIGH` — remembered across sessions. LOW drops the
resolution cap, shadows and half the scenery detail; HIGH forces full density and shadows. AUTO keeps the
old device heuristics (coarse pointer + core count + screen size).

## 🏚 Enterable buildings

The shoulders are lined with **18 enterable structures** that recycle as you drive. Every one has a real
interior: walls you collide with, a doorway you walk through, loot crates and a roof that peels away the
moment you step inside.

| Building | Loot multiplier | Notes |
| --- | --- | --- |
| `house` | ×1.35 | living room, kitchen counter, bedroom |
| `shack` | ×1.0 | one room, thin walls — quick snatch and go |
| `barn` | ×1.25 | big open floor, hay bales, tractor junk |
| `warehouse` | ×1.7 | racks, pallets, the best industrial loot |
| `store` | ×1.45 | shelves and a counter, plenty of small items |
| `garage` | ×1.5 | lift, tool bench, **extra fuel** |
| `church` | ×1.3 | pews, altar, candles |
| `clinic` | ×2.0 | exam tables, IV stands, drug cabinets — best chem loot |
| `depot` | ×1.6 | bus garage: wrecked van, luggage racks, two loot spots |
| `farmhouse` | ×1.4 | wood stove, long table, pantry shelves |
| `motel` | ×1.35 | row of rooms, made beds, reception desk, back-alley dumpster |
| `roadhouse` | ×1.5 | bar counter, bottle shelf, booths, neon over the bar |
| `bunker` | ×1.8 | concrete, sandbags, military crates |

How it plays:

* Park, press `E` to step out, walk through the door. The roof lifts, the camera tightens and the
  minimap marks the house you are standing in.
* `G` searches the room and **scatters physical drops** on the floor — you have to walk over them to
  collect anything (driving over drops works too). Loot scales with the building type and an indoor
  bonus, then the place is picked clean for 32 s. Cars cannot drive through a building; only people
  fit through the doorway.
* Interiors are lit by the world sun plus a warm fill light that fades in as you cross the threshold,
  so a midday raid is safe and a night raid is tense instead of pitch black;
* **hinged doors** creak open as you step onto the porch and shut behind you — wide warehouses
  get double leaves, and the panels open inward so a doorway is never blocked.

## 🎒 Loot, backpack and hotbar

Everything you scavenge exists in the world first:

* crates bust open and spill **stacks on the ground** — scrap, steel, medkits, fuel cans, flares, gear;
* search a house from the **doorstep** and the haul spills onto the porch (interiors pay more, and
  searching after dark pays a **25% night bonus** — the storm is the price);
* corpses are lootable too: hollows drop **dogtags**, raiders leave **ammo/fuel/repair kits**,
  boss rigs pay **cores, blueprints and titanium** — all as physical drops you drive over;
  off the porch you cannot reach it, so the drops always stay walkable;
* drops bob, glow and drift toward you, then land in your pack when you actually touch them
  (auto-collect radius grows with the `magnet` upgrade perk);
* materials (scrap / steel / titanium / carbon / leather / chem / cores) feed the workbench;
* items live in a **30-slot backpack** (`I` or the 🎒 button) and an **8-slot hotbar**;
* tap an item in the backpack to pin it to a hotbar slot, then press **1–8** to use it —
  medkits heal, fuel cans refuel, repair kits patch the hull, flares light the road;
* the pack sorts itself (usables → gear → raw salvage) and filters by **ALL / USABLE / GEAR / SALVAGE**
  with live counts, so a full 30-slot pack never turns into a wall of icons;
* every usable cell carries its own **USE** button — phones never have to hunt for a hotbar slot;
* every non-material stack has a **TOSS** button: it drops in front of you with a short grace window,
  so survivors can hand loot to each other over the ground;
* **Esc** puts the bench *and* the backpack away and unpauses; opening one stows the other.

## 🛠 1000 crafting recipes

The workbench holds **1,015 recipes**: the original 17 hand-tuned staples plus **1,000 procedurally
generated ones** across five tabs — WEAPONS · REPAIRS & FUEL · RIG UPGRADES · GEAR · CONSUMABLES.
Generation is seeded, so recipe `gen-0500` is the same on every device.

* **search** by name or effect, **page** through 24 cards at a time, filter by tab;
* generated upgrades install **permanent perks**: `+MAX HP`, `+TANK`, `+DAMAGE RESIST`, `+WEAPON DAMAGE`,
  `+SCAVENGE YIELD`, `+PICKUP RANGE` (each capped, shown as MAXED when full);
* generated repairs/fuel/consumables resolve immediately or drop items into your pack.

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
`SUPABASE_ANON_KEY` in *Project → Settings → Environment Variables* (all three environments), then
**redeploy** — env changes only apply to new deployments. The build log prints
`supabase accounts: configured (url from SUPABASE_URL)` when they were picked up, and
`dist/config.json` is generated from them as a fallback. Online play on Vercel uses the polling lane; for
low-latency WebSocket rooms host `server.mjs` and pass `?relay=`.

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
  js/world.js         infinite highway, biomes, props, pit-stops, buildings, sky, weather FX
  js/buildings.js     enterable building factory: merged geometry, wall colliders, loot spots
  js/admin.js         owner console UI (players, spawns, weather, teleport, bans)
  js/vehicle.js       rig mesh + arcade driving physics + anchors + damage
  js/avatar.js        blocky survivor rig, face, name tag, weapons, walk cycle
  js/enemies.js       hollows, raider cars, boss rig
  js/tornado.js       funnel visuals, swirl debris, pull/lift force field
  js/net.js           multi-transport multiplayer client
  js/hud.js           HUD, radar scope, paginated workbench, chat, toasts
  js/items.js         item + drop-table catalogue (materials, medkits, fuel cans, gear)
  js/loot.js          physical loot drops: meshes, magnet drift, pickup, expiry
  js/inventory.js     backpack model + hotbar/backpack UI
  js/recipes.js       15 staples + 1000 generated recipes (seeded, effects)
  js/effects.js       pooled particle bursts (budgeted per device)
  js/audio.js         procedural WebAudio engine/wind/impacts
api/                  Vercel functions: /api/room, /api/health, /api/config, /api/admin
lib/admin-auth.mjs    server-side owner check (Supabase token → username → allow-list)
supabase/schema.sql   tables, RLS policies, friend RPCs, owner gate, bans, signup trigger
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
* **interiors + owner console** — all thirteen building archetypes enterable, doorways walkable, walls solid,
  roof hide/restore, interior looting + cooldown, and the admin gate: owner token verifies, a normal
  player's token is refused, the shipped anon key cannot unlock admin, forged ban calls return 403.
* **loot + inventory + recipes** — 1000 generated recipes unique and browsable, drops only bank when you
  stand on them, magnet/expiry behaviour, stack caps, hotbar pinning, medkit/fuel/repair use, 24-per-page
  workbench paging + search, and every one of the 1,015 recipes crafting without an error.

## ⌘ Owner console (`ghanimz`)

Sign in as **`ghanimz`** and a `⌘ OWNER` button appears in the HUD (or press the backquote key).
It is invisible for every other account.

**No Supabase configured yet?** The game then has no accounts at all, so it falls back to the local
survivor name: type `ghanimz` in the lobby name field and the console opens in *local owner* mode
(badge reads `LOCAL OWNER · NO ACCOUNTS`). The moment Supabase credentials exist, that shortcut is
disabled and only the real `ghanimz` account — server-verified — can open it.

What it does: set the day, scrub time of day, force weather and biome, teleport to a pit-stop or the next
house, heal/refuel the rig, god mode, +50 of every material, unlock workbench tier 4, spawn hollows,
raider rigs, boss rigs and Cat 1/3/5 tornadoes, clear hostiles or storms, and inspect live stats
(fps, entities, position, relay mode). The **players in room** list lets you teleport to, kick or ban
anyone connected; the **ban list** is stored in Supabase and can be lifted again.

It is gated twice:

1. **Client** — `public/js/admin.js` only mounts for the owner username.
2. **Server** — every privileged call (`/api/admin?action=verify|bans|ban|unban`) resends your Supabase
   access token; the function resolves it against Supabase `/auth/v1/user` and refuses unless the
   username is the owner. The `bans` table is protected by RLS (`public.is_owner()`), so a forged
   client cannot read or write it even with devtools open.

After pulling this version, re-run `supabase/schema.sql` once — it adds `public.admins`,
`public.bans`, `public.owner_username()`, `public.is_owner()`, `public.ban_player()` and their policies.
Want a second owner? Change the username in `owner_username()` **and** in `lib/admin-auth.mjs`
(or set an `ADMIN_USERNAME` env var on Vercel).

## Legacy 2D build

The first iteration — a single-file, top-down canvas version — is preserved untouched at
`/legacy/index-2d.html` (design doc: `docs/GDD-legacy-2d.md`).

## Notes

* Rendering: WebGL2, PCF shadows, ACES tone mapping, pooled objects for an endless road.
* License: Apache-2.0 (see `LICENSE`).

Stay on the asphalt. The wind does not care.

See `docs/DEPLOY-VERCEL.md` for the phone-friendly Vercel walkthrough (including how to read the
`CONNECT SUPABASE` diagnostic).
