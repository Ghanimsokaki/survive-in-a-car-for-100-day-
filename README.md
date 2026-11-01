# GEMBY GAMES — 100 Days Outrun, Iron Tide & Star Battle

**Gemby Games** is a **3D multiplayer arcade for phones**, and the shelf carries three games: the flagship
**100 Days Outrun** — one rig, one hundred days, a highway that throws scavengers, raider cars, acid rain and
Category 5 hypercanes at you the whole way — **Iron Tide**, the ship builder and fleet battle, and
**Star Battle**, where you fly the **U.S.S. Enterprise-E (NCC-1701-E)** against the **Narada** and the
**Vengeance**.

Roblox-style **username + password sign-in**, a **friends list with live presence**, full **phone support**,
real-time rooms of 1–8, and a game that runs on plain Node or on **Vercel**.

![engine](https://img.shields.io/badge/engine-Three.js%20r169-ff8a1e) ![accounts](https://img.shields.io/badge/accounts-Supabase-3ecf8e) ![multiplayer](https://img.shields.io/badge/multiplayer-Socket.IO%20%C2%B7%20Supabase%20%C2%B7%20fallbacks-5ff0ff) ![mobile](https://img.shields.io/badge/phones-touch%20ready-5ff0ff) ![deploy](https://img.shields.io/badge/deploy-Vercel-black) ![rooms](https://img.shields.io/badge/rooms-1%E2%80%938%20players-ffb347)

---

## ▶ Play

```bash
npm install        # express + socket.io (the game itself needs nothing)
npm start          # http://localhost:8080 — the Socket.IO room server
npm run relay      # http://localhost:8000 — zero-dependency static + WebSocket relay
npm test           # 30 headless suites (simulation, accounts, P2P rooms, UI flows, the live server)
```

No build step. `public/vendor/three.module.js` is vendored, so the game boots even offline; `npm run relay`
serves it with no dependencies at all, and `npm start` adds Socket.IO rooms on top.

## 🧯 Errors: what is guarded, and where

The game is built so that a failure is *local and visible* instead of a frozen screen:

| Failure | What happens |
| --- | --- |
| A module 404s | the dev server answers a real **404** (it used to answer `200` + `index.html`, which the browser reports as a confusing MIME error). PLAY shows "could not load the 3D engine", restores the button and retries. |
| The 3D kit fails to load | the lobby stays on screen, portrait is handed back, nothing is blocked. |
| A frame throws | simulation and drawing are guarded separately. A failed **draw** steps the graphics down one notch and retries (shadows → post layer → resolution → particles → safe mode), so a fussy GPU ends up playable instead of black. A failed **update** keeps the loop alive, warns after 30 frames and pauses after 120 instead of burning the battery on a still image. |
| Anything throws at all | the **error bar** names the actual message (`PROBLEM: …`) and carries a real **RESTART** button — in a run, and even before the game boots (`window.onerror` / `unhandledrejection`). The last failure is kept in `window.__outrunLastError` for a bug report. |
| The GPU drops the context (backgrounding, OOM, driver reset) | `webglcontextlost` is caught, drawing pauses, and `webglcontextrestored` resumes the loop with a clean clock. Without this a phone shows a black canvas for the rest of the session. |
| A browser refuses AudioContext / fullscreen / orientation lock | the feature is skipped (`console.warn` at most); the game keeps playing, silently. |
| A community game loads without the hub SDK | both Iron Tide and the template fall back to a local `sdk` shim instead of throwing `ReferenceError` every frame. |
| A directory has no `index.html` | 404 — it is never silently answered with the hub page. |

`npm test` covers the observable half of that list (the frame guard, context loss, the SDK
fallback, the 404 rules and the loader contract); the browser half is guarded with optional
chaining so an absent API can never throw.

## ⚡ No loading — anywhere

There is **no splash, no loading card, no progress bar and no percentage** left in the app. The words
"loading" and "loading…" do not appear in the UI at all.

* **Boot** — the sign-in screen is static HTML, so it is interactive before a single module parses.
* **PLAY** — the lobby stays up and the run begins the instant the engine is ready. The button is only
  *disabled* while that happens (never re-labelled), so a double tap cannot start two runs, and if
  something fails you land back on the menu with the real reason in the error bar.
* **The kit is preloaded from the markup** — `modulepreload` for `game.js`, `world.js`, `hud.js`,
  `net.js` and friends is in `<head>`, so the browser fetches them at parse time; the loader only
  *caches* them. By the time a player has typed a name, PLAY has nothing left to wait for.
* **Warm start** — the kit also starts importing 600 ms after the menu is interactive (and again on the
  first tap), because `requestIdleCallback` never fires on a page that draws an avatar preview every frame.
* Removed with it: `#loading`, `.ld-bar`, `.ld-text`, `setLoading()`, `onKitProgress()`,
  `kitProgressState()`, the byte-counting stream reader and the `LOADING 42%` button copy.

## ⚡ Fast loading

The menu used to cost a megabyte before it worked: `main.js` statically imported three.js (690 KB) and
`game.js` (90 KB) plus the world, vehicle, avatar, tornado and HUD modules, so the sign-in box was on screen
but dead for seconds on a phone. Now:

* **The home is a menu, not a game.** `main.js` statically imports ~126 KB (12 small modules) and nothing
  from the 3D engine. `import('./game.js')` happens on PLAY — or in the background via
  `requestIdleCallback` once the menu is interactive, so PLAY is usually instant.
* **The avatar portrait is 2D.** `public/js/preview.js` draws the sign-in/lobby survivor with the plain
  canvas API (no WebGL context, no imports). The 3D rig is only built when a run starts.
* **The catalogue is cached.** `games/index.json` paints from `localStorage` first, then refreshes behind
  it; ratings load in parallel instead of in front of the shelf.
* **Config is asked once, in parallel.** `/api/config` and `config.json` are fetched together instead of
  one after the other, and the boot never waits on them to show the menu.
* **The wire is small.** The Node server gzips/brotli-compresses text (`three.module.js`: 690 KB → 166 KB),
  sends `ETag`/`304` on repeat visits, and marks `/vendor/*` immutable for a year. Vercel gets the same
  cache policy from `vercel.json`.
* **Nothing can trap you.** If the module graph fails, the boot card turns into "still loading — check your
  connection" and then fails open to the sign-in screen.

`tests/boot.test.mjs` walks the real import graph and fails the build if three.js or `game.js` ever creeps
back into the home path, and checks the compression, the 304 and the cache headers against a live server.

## 🕹 The arcade

The first screen after sign-in is the **arcade**: a hub with the built-in game plus every community game
in the repo. Cards show the creator, tags, star rating and play count; **Records** has your best run per
game and a star rating you can change any time.

**Two games, on purpose:**

| Card | What it is |
| --- | --- |
| **100 DAYS OUTRUN** | the built-in 3D game — *one* game with **five modes** (100 Days · Endless Road · Siege · Fuel Run · Storm Chaser), chosen in the lobby. Its modes are printed on the card, so it reads as one game with a lot inside it, not five downloads. |
| **IRON TIDE** | the ship builder / fleet battle: build a hull, buy jets, sink other captains. |
| **STAR BATTLE** | the starship duel: the Enterprise-E against Nero's Narada and Khan's Vengeance, wave after wave. |

The shelf is generated from `games/index.json` (see `scripts/scan-games.mjs`), so it is still a platform:
add `games/<slug>/` in a pull request and it appears once merged. The five older sample games
(`last-convoy`, `radio-tower`, `pit-stop-panic`, `scrapyard-run`, `signal-lost`) are **parked** in
`games/_parked/` — kept in the repo as examples and contributors' reference, skipped by the scanner, the
generated catalogue, the hub and the build.

### ⚓ Iron Tide (ship builder + fleet battle)

Build the ship, then take it to war.

* **Dock** — four hulls (skiff → corvette → destroyer → carrier), each with its own slot count, hull
  points and speed. Your first skiff is free; every upgrade has to be earned.
* **Build** — drop cannon, heavy cannon, torpedo, flak, armour and engine modules into the slots. The
  loadout panel live-recomputes hull, dps, range, speed and the price before you commit.
* **Hangar** — buy jets with credits from the dock: scout, interceptor, bomber, gunship. Jets fly
  themselves and strafe whatever you are shooting at; the carrier launches three at once.
* **Sortie** — sail against a fleet of other captains (AI). Steering with the stick, fire broadsides,
  launch jets, and retreat when the hull bar turns red. Sinking ships and surviving the sortie pays
  credits and salvage, and every run is scored into the arcade leaderboard.
* **It is 3D now** — `sea3d.js` is a dependency-free WebGL renderer with four programs: the ocean, lit
  solids, a sky with a sun, and additive billboards. The sea is a **radial** grid (fine under the bow,
  coarse at the fog line) displaced in the vertex shader from the *same* wave set `water.js` simulates,
  so the swell you look at is the swell that lifts your hull — with analytic normals, slope-based foam
  and distance fog. Hulls heel and trim from the physics body, spray and splashes are one additive draw,
  and seven islands give the battle a shape you can actually run into (they are solid).
* **A chase camera, not a chart** — the view sits 30 metres up and ~110 behind the stern, so the roll of
  the deck and the size of a destroyer read at a glance. `#c` stays on top as the overlay: the stick, the
  lock bracket, hull bars over contacts, the range ring drawn as a circle *on the water*. If a device has
  no WebGL, or a frame throws, the old chart view carries the battle — the game never dies of a render.

### 🖖 Star Battle (open-sector starship battle)

A sector you can fly, three Enterprises, and the dark.

* **The player's side is the Enterprise** — the **U.S.S. Enterprise-E, NCC-1701-E**, with
  **460 hull and 520 shields** that regenerate once the hits stop. Phasers, four quantum torpedoes and an
  evasive pattern that buys you half a second of doubled thrust.
* **The enemies are the film ships** — **Nero's Narada**, a mining rig with **900 hull and no shields** that
  throws torpedo volleys, and **Khan's Vengeance**, a dreadnought with **640 hull and 220 shields** that fires
  phasers on the move. Wave 1 is a lone Narada; after that every wave is bigger, and then the ships themselves
  get tougher (capped, so late waves stay beatable).
* **It is 3D now** — the chase camera sits 152 units behind the hull and 74 above the flight plane, the
  ship is the real model lit in WebGL, and the sector is drawn around you: a star shell 4,000 units out,
  a 300-unit grid on the flight plane, and the boundary ring you can see coming. `gl.js` is a small,
  dependency-free WebGL 1 renderer — three programs (ship / solid / additive billboards), a line pass for
  the grid, and an indexed draw per hull. No three.js inside the sandbox, no loader, no fetch.
* **An open world, not a wave arena** — every run seeds a sector with six landmarks (two starbases, Risa,
  Vulcan, a derelict and a debris field) and four objectives: clear three contacts, rescue the derelict,
  survey two landmarks, report in. Objectives pay score and repair the hull; the run log on the title card
  keeps the last six.
* **Two more Enterprises fly with you** — `ENTERPRISE-D` and `ENTERPRISE-F` hold a firing lane beside you,
  shoot what comes close, and count as your wing on the result card. When the hub knows who else is in the
  room, the wing flies *those players* instead, with their names tagged over the hull — the names arrive with
  `arcade:init`, because a sandboxed frame cannot open a socket of its own.
* **A hangar, not a fixed ship** — the title card's hull panel opens the shipyard. Three starter hulls
  (**Enterprise-E** 460/520/216, **Saber** 300/380/272, **Akira** 620/600/178) and eight upgrade lines:
  impulse power, thrusters, shields, hull plating, warp core, torpedo bay, photon laser and crew quarters.
  Requisition is earned in the sector — every kill, every cleared wave, every completed objective — and a
  purchase folds into the run in progress, so hull plating bought at half health is hull you can use.
* **A crew you hire, and stations you can hand over** — you start with a helmsman and a tactical officer in a
  three-berth hull, and can hire engineering (faster shield regeneration), medical (hull repair) and science
  (the warp core spools twice as fast). Touch a station in the ship interior to give it to the crew: the
  helmsman will fly at the nearest contact and hold a firing range, the tactical officer fires when you do
  not, and touching the stick takes the helm straight back.
* **Ship interior, in 3D** — `MAIN ENGINEERING` is a compartment you look *into*: deck plating with seams,
  bulkheads broken into bays and lit by strip lighting, ceiling ribs fading into the dark, and the warp core in its
  cradle with plasma climbing it — faster and brighter with every core upgrade, red-hot when the hull is holed.
  Every station has a waist-high console, and every berth somebody works has a figure standing at it in their
  role's colour; a vacant berth is an empty bay with no figure at all, which is the whole point of the panel.
  `interior3d.js` builds the room from `gl.js` primitives (`gl.solid` — three sizes, real per-axis normals) on its
  own canvas (`#c4`) at 20 fps, so the fight behind it pays almost nothing; a tap swings the camera, and a device
  with no WebGL keeps the old 2D cutaway as the fallback.
* **Controls** — drag the left side for the stick, **hold FIRE** on the right (a pointer-down, not a click:
  the old code fired on release, which is why it felt dead on a phone), **TORPEDO** for a quantum spread,
  **WARP** to throw the ship 1,200 units along the helm toward the live objective and then spool for
  thirteen seconds, **EVADE** to break a lock. Keyboard: WASD/arrows, `Space`, `Shift`, `Q` to warp, `E` to
  evade.
* **The ships are the real model, twice over** — `model.fbx` in the repository root (a futuristic
  sci-fi starship, 149k triangles, with the base-colour, normal, metallic and roughness maps in
  `starship+3d+model.zip`) is baked at build time by `npm run bake` into **two** things:
  * `art/ship-mesh.js` — the hull itself, 14,520 triangles in 16 bytes a vertex (position `int16×3`,
    normal `int8×3`, albedo `uint8×3` sampled from the model's own base-colour map, roughness `uint8`),
    quantised, interleaved and base64'd into a **classic script** so it needs no fetch, no loader and no
    CORS inside the sandboxed frame. That is what the WebGL renderer draws.
  * `art/ships-{player,narada,vengeance}-{high,low}.png` — 32-heading turntables in three liveries, which
    are the **fallback** renderer and the sprite path for any device without WebGL.
  Both come from the same decimation and the same lighting maths, so the 3D hull and the 2D sprite look like
  the same ship from the same shipyard. Change the model, re-run `npm run bake`, done.
* **Three renderers, in order** — WebGL (`gl.js` + the baked hull) → the baked turntables on a plain 2D
  canvas → the vector art in `drawEnterprise` / `drawNarada` / `drawVengeance`. Each step is a fallback for
  the one above it, and a GL frame that throws once drops to 2D **for the rest of the run** instead of
  blanking the screen. The 3D canvas is a separate element from the 2D one, because a canvas that has
  handed out one context can never hand out the other.
* **The GUI has the exit where it belongs** — the in-game HUD's top-right cluster is `❚❚ pause`, `⤢
  fullscreen`, `✕ leave`, side by side, and the hub's player bar carries `⟳ restart`, `⤢ fullscreen`,
  `✕ back` in that order. The game's fullscreen button posts `arcade:fullscreen` to the hub, because a
  sandboxed iframe cannot request fullscreen for itself.
* **History** — the hub's Records tab now opens with **RECENT RUNS**: every finished run on this device,
  newest first, with the game's title, its day/time and the score (`ArcadeStats.history`, capped at 30 and
  stored next to the boards). Star Battle also keeps its own last six on the title card.
* **Rendering** — additive engine bloom and warp trails, six-plate rotating shields, phaser beams with a
  hot core and an impact bloom, torpedo trails, shockwave rings, screen shake, a hit-marker bracket, a
  damage vignette that tracks the hull, and an adaptive-quality watchdog: a phone that cannot hold ~45 fps
  loses particles and resolution first, and gets them back when the frames are cheap again.
* **The leaderboard is Supabase, fetched once** — the hub queries `game_runs` for a game's top five at
  most **once a minute** (`ArcadeStats.topRuns`, cached in memory and prefetched when the shelf paints),
  and hands the answer to the game with `arcade:init`. The game inside the sandboxed frame has no key and
  makes no request of its own; it just paints the board on the title card.

### Add your own game (pull request)

Games live in `games/<id>/` and are loaded in a sandboxed iframe. **Pin your base** — copy the `pinBase()`
block from `_template/index.html` — because hosts disagree about trailing slashes: Vercel serves
`/games/<id>` without one, and a relative `<script src="game.js">` would then ask for `/games/game.js` and
404. That is what made Iron Tide look like a game that never loads.

```
games/<your-game>/
  game.json     ← manifest: id, title, author, blurb, tags, version, entry, icon
  icon.svg      ← square card art
  index.html    ← your game (plain HTML/JS/canvas, no build step)
  game.js
```

1. Copy `games/_template/` to `games/your-game/` — the folder name **is** the id.
2. Write your game; load the SDK with `<script src="../_shared/sdk.js"></script>`.
3. Open a PR adding the folder. `npm run games` regenerates `games/index.json`; `npm test` validates
   every manifest, and the build bundles `games/` into `dist/` automatically.

Community games run in **`<iframe sandbox="allow-scripts">`** — no same-origin access, so a submitted game
cannot read the hub's DOM, `localStorage`, the Supabase session or another game's data. It talks through a
small validated `postMessage` protocol:

```js
Arcade.ready();                                                    // accept input
Arcade.on('start', (player) => { /* name, color, room, custom */ });
Arcade.state({ day: 3, status: 'HOLD THE LINE' });                 // optional live chip
Arcade.score({ score: 1240, seconds: 96, won: true, meta: 'day 12' });
Arcade.close();                                                    // back to the arcade
```

Full rules, the manifest schema and the SDK: **[`games/README.md`](games/README.md)**.

### Ratings, plays and leaderboards

Stars and runs are stored in Supabase (`game_ratings`, `game_runs`, plus the `game_stats` view) so the
catalogue reads the same on every device. Guests get a local board instead, and a deployment without the
SQL still works — `arcade-stats.js` degrades quietly.

> **On "use Supabase for performance":** Supabase is a Postgres database over HTTPS. It stores ratings,
> runs and presence; it never touches a frame, so it cannot raise FPS, and moving per-frame state
> (positions, physics) into it would make the game slower. Performance work lives in the client: the
> adaptive frame governor (render scale → shadows → particles) and the quality-tiered avatar materials.

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

**Where to add somebody:** the lobby card, or the **Add Friends** tile in the arcade (top of the hub). Both
open the same sheet, and both accept:

* an `@username` (`@ghanim`), with or without the `@`;
* a plain username in any capitalisation (`Ghanim`, `GHANIM`);
* a **display name**, as long as exactly one survivor has it — an ambiguous name (or a partial match hitting
  several people) tells you to add by `@username` instead of silently picking somebody.

Every failure is spelled out in the sheet: *no survivor called "…"*, *that is you*, *already on your list*,
*your Supabase project blocked the write — re-run `supabase/schema.sql`*. Nothing fails silently any more.

Guests still get the shared highway and chat — they just have no persistent friends list.

## 🖼 Your own account picture

Open it from the hub avatar, **⚙ SETTINGS** (lobby or hub) or the in-run gear, then **CHOOSE PICTURE**:

* the photo is **centre-cropped square and resized to 196 px on the device** before it is saved — a 6 MB
  camera photo becomes a few kilobytes, so the friends list and the Supabase free tier stay happy;
* the stored value is a `data:` URL in `profiles.avatar_image`; the schema refuses anything that is not a
  small inline image, or anything over 420 KB;
* the picture shows in the hub header, the lobby account chip, the friends list, the player panel **and on
  the 3D nameplate above your head** in a run;
* **REMOVE** clears it and falls back to your two initials on your saved colour.

Projects on an older schema are handled honestly: the write drops the `avatar_image` column, keeps your name
and colours, and tells you the picture is saved on this device only. Run `supabase/schema.sql` once to sync.

## 🎛 Settings

One panel, three places to open it (hub ⚙, lobby ⚙, in-run gear, or the **P** key), stored in
`outrun-settings-v1`:

| Setting | What it does |
| --- | --- |
| **VOLUME** | master gain on every synthesised sound (0–100 %, or MUTED) |
| **MUTE** | a true zero on the audio graph, not a flag each effect has to remember |
| **SCREEN SHAKE** | 0–100 %; 0 is a still camera, applied at every shake site in one place |
| **GRAPHICS** | AUTO / LOW / MED / HIGH / ULTRA — applied to the running game immediately |

Changing the tier mid-run re-applies shadows, exposure, pixel ratio, particles and the CSS post layer without
a restart. The lobby's GRAPHICS row and this panel share one store, so they can never disagree.

## 📱 Phones

The whole game is phone-first:

* **Left thumb = virtual stick** (steer/throttle/brake, push to the edge to boost). **Right side = look**
  drag; **pinch** to zoom the camera.
* Big 48 px action cluster: anchor, workbench, scavenge, enter/exit rig, attack.
* No pinch-to-zoom-page, no scroll, no iOS zoom-on-focus, safe-area insets on notched screens.
* **The menu is portrait, the run is landscape** — automatic, no tap required (see below) — plus a ☰
  in-game menu (tap twice) to leave the run.
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

### The home is portrait, the run is landscape

The sign-in, lobby and arcade are a **portrait** menu: cards stacked down the screen, the tab bar under the
thumb, no sideways scrolling, 44 px tap targets and safe-area padding for notched phones. The app no longer
declares `screen-orientation: landscape` in its `<meta>` tags or its web manifest (`orientation: "any"`),
because a phone that opens the game on a menu should not be yanked sideways before the player has pressed
anything.

Landscape is requested **only while a run is live** (`body.run-live`): pressing PLAY on the 3D game, or
opening a game in the arcade. Leaving the run calls `requestPortrait()` — which unlocks the orientation and
leaves fullscreen — so the home comes back upright.

### Auto landscape during a run

`public/js/orientation.js` is the single owner of orientation, used by the 3D game, the arcade hub and the
sandboxed community games:

1. **`screen.orientation.lock('landscape')`** — requested together with fullscreen, because Android/Chrome
   only grant the lock from a user gesture; the request is retried on the next few pointerdown/keydown
   events until it sticks, and a successful lock also unlocks the lock again on unload.
2. **Fullscreen first** on phones — `requestFullscreen()` hides the browser chrome so the lock is allowed
   and the canvas gets the whole display.
3. **CSS rotation fallback** — where the platform refuses (notably iOS Safari, which allows neither the
   lock nor always-on fullscreen) the app rotates the run itself: `body.auto-land.run-live` becomes a
   fixed `100vh × 100vw` stage turned 90° from its top-left corner, so the game is landscape before the
   player touches anything. Because a transformed element becomes the containing block for fixed
   children, the canvas, HUD, stick and toasts all lay themselves out in that stage. The renderer and
   the camera read `stageSize()` (axes swapped while rotated) and every touch is mapped back with
   `toStagePoint()`, so a swipe to the right on screen still steers to the right in the game. Turning
   the phone for real removes the class again — nothing is sticky.

The arcade's player does the same inside its own frame: in portrait it switches `.ap-stage` to a fixed,
rotated stage and docks the toolbar to the bottom, so community games get a wide stage too. Nothing is
blocking — if every step is refused the game still runs in portrait.

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

## ⚙️ Graphics: AUTO · LOW · MED · HIGH · **ULTRA**

The lobby has a **GRAPHICS** switch, remembered across sessions. Every renderer decision now comes from one
table (`public/js/graphics.js`) instead of scattered `quality === 'high'` ternaries, so a tier is a complete
description of the scene:

| | LOW | MED | HIGH | **ULTRA** |
| --- | --- | --- | --- | --- |
| render scale cap | 1× | 1.4× | 1.85× | **2.5×** |
| shadows | off | 1K | 2K soft | **4K soft, 78 m frustum** |
| draw distance | 300 m | 430 m | 560 m | **760 m** |
| scenery props | 56 | 72 | 96 | **124** |
| cloud layers | — | 1 | 2 | **3** |
| PBR environment | — | — | ✓ | **✓ stronger** |
| avatar detail | low | medium | high | **ultra (26-segment parts)** |
| particles | 0.45× | 0.7× | 1× | **1.5×** |
| post layer | — | vignette | + glow | **+ grain + lens flare** |

* **ULTRA is opt-in** — never auto-selected, because a weak integrated GPU would stutter before the frame
  governor noticed. It still degrades gracefully: the governor trades resolution (down to 0.7×) to hold the
  frame rate.
* The **post layer** (bloom-ish sun glow, anamorphic flare, film grain, chromatic edge falloff) is pure CSS
  over the canvas — `html.q-high` / `q-ultra`, and only while `body.run-live` — so none of it costs a render
  pass. `prefers-reduced-motion` turns the grain animation off.
* The **clouds** are new: 1–3 layers of soft sprites on a procedural canvas texture, drifting and recycling
  around the camera (`World.buildClouds`). They fade out at night with the rest of the sky.
* AUTO now only drops to LOW on genuinely weak hardware (`≤ 3 cores` or a sub-360 px viewport); a modern
  phone gets MEDIUM, which keeps its shadows.
* Weather used to hard-code a 430 m horizon and silently threw away the tier's draw distance — it now scales
  the tier's value instead (storm = 70 %, dust = 35 %, clear = 100 %).

## ⛶ Fullscreen

One button in three places — the arcade top bar, the lobby header and the in-game HUD — plus **Alt+Enter**
and **Shift+F** (never inside a text field, so chatting is safe). `public/js/fullscreen.js`:

* Calls `requestFullscreen({ navigationUI: 'hide' })` inside the click/keydown gesture (the only time
  browsers allow it), with `webkitRequestFullscreen` / `msRequestFullscreen` fallbacks.
* **Degrades instead of breaking**: iOS Safari refuses fullscreen for anything that is not a video, so the
  module reports `unsupported`, the button dims, and the rest of the game carries on (the CSS-rotated
  landscape stage still works).
* Remembers the preference, and re-applies it on the next **PLAY** tap — a real gesture, so it is allowed —
  never automatically on load.
* Syncs on `fullscreenchange`, so Esc / F11 / a system swipe keeps the icon honest, and adds safe-area
  padding for the notch once the browser chrome is gone.

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

## 👥 Multiplayer — peer-to-peer first, Socket.IO beside it

Share a **room code** (or press *quick play*). Everyone in the room shares the highway: positions,
driving/walking state, health, weapon, hits and chat go out up to 15×/s. One JSON envelope, six lanes,
tried in this order:

0. **Peer-to-peer WebRTC** (`public/js/webrtc.js` + `public/js/p2p.js`). Whoever opens the room is the
   **host**; everyone else connects straight to them, browser → browser, and nothing of ours is in the
   path. Supabase Realtime is used *only* as the signalling channel (a separate topic,
   `realtime:room:p2p-<room>`, carrying `hello` / `join` / `offer` / `answer` / `ice`), so a static
   deploy with an anon key gets low-latency play for free. The topology is a **star**, not a mesh: a
   guest holds one connection and the host relays what it hears to the other guests, stamping the real
   author so nobody can impersonate anybody. Two data channels per peer: `state` (unordered, no
   retransmits — telemetry that is late is worthless) and `control` (reliable — chat, hits, joins).
   Rooms are 1–8, ids are re-electable (lowest id keeps hostship), and a silent host is noticed after
   9 s. It needs no server, but it does need a path between the two networks: **STUN only, no TURN**, so
   two symmetric NATs (some mobile carriers) cannot pair. That case is handled rather than hidden: a
   connection that never opens is dropped after 8 s, and a guest with no working channel after 12 s hands
   the room to the next lane — it never sits on `P2P` with an empty map, and `?relay=` still wins if you
   want to force a particular server.
1. **Socket.IO** (`server.js`, `npm start`). A real realtime host: rooms of **1–8**, matchmaking codes,
   15 Hz vehicle telemetry, chat with rate limits, connection-state recovery and ghost-seat reclaiming.
   The server advertises itself on `/api/health` (`engine: "socket.io"`), so a page served by it — or a
   page told about it with `?relay=https://your-server` — uses this lane automatically.
2. **Supabase Realtime**. The client joins the broadcast channel `realtime:room:<room>` **directly** —
   phone → Supabase edge → phones. No server of ours in the path at all, so it works on a static Vercel
   deploy with just the anon key.
3. **WebSocket relay** in `server.mjs` (`npm run relay`) — a bare clone without Supabase credentials, or a
   self-hosted relay via `?relay=wss://your-relay.example/ws`.
4. **HTTP polling** via `POST /api/room` — serverless hosts without sockets, best effort.
5. **BroadcastChannel** — always on, so two tabs on one machine see each other instantly.

The fallbacks are automatic and quiet: no WebRTC in the browser, a refused signalling topic, a failed
ICE handshake or a project that refuses the join brings the next lane up beside it, and the HUD names
whichever lane is actually carrying play (`P2P HOST` / `P2P` / `SOCKET.IO` / `SUPABASE` / `RELAY` /
`HTTP RELAY`).

`public/js/realtime.js` is a ~200-line, dependency-free client for Supabase's realtime protocol (Phoenix
channels): join, broadcast, 25 s heartbeat, reconnect with backoff, leave. `tests/net-e2e.test.mjs` runs
two real clients through a real socket against a stand-in edge and asserts they meet, chat and leave —
without a relay anywhere. `tests/p2p.test.mjs` pins the protocol (validation, clamping, host election);
`tests/p2p-e2e.test.mjs` stands a fake `RTCPeerConnection` and a broadcast signalling bus behind the real
room and drives host + two guests through election, handshake, relay, impersonation attempts, a host
leaving and a handshake that never completes; `tests/p2p-net-e2e.test.mjs` then runs two real `Net`
instances over a real socket to prove the *lane glue* — signalling-only topic, telemetry over the data
channel, host-stamped authorship, host-quits recovery, dead-topic fallback and the `?relay=` override.

### The Socket.IO server (`npm start`)

`server.js` is the production realtime host: Express for HTTP, Socket.IO for the wire.

```bash
npm install
npm start                     # node server.js → http://0.0.0.0:8080  (PORT || 8080, bound to all interfaces)
PORT=8000 npm start           # …or wherever the host points you
```

It also serves the site, the Socket.IO client **and `/games/*`** (the community games live next to
`public/`, not inside it, so the source tree and a built `dist/` both work — a server started without a
build used to answer the ship's iframe with a 404, which looked exactly like a game that never finished
loading). `_`-prefixed folders stay private, `_shared` ships, and game HTML is served `no-store`.

| Endpoint | What it is |
| --- | --- |
| `GET /health` | liveness, room/player counts, engine + realtime path, and the CORS allowlist |
| `GET /api/rooms` | public room list (`code`, `mode`, `players`, `max`) — no player ids |
| `GET /api/config`, `/config.json` | Supabase credentials + realtime hints, exactly what Vercel's function serves |
| `GET /socket.io/socket.io.js` | the browser client, served by the server itself (no CDN) |
| `GET *` | the built game (`dist/` when present, `public/` otherwise) |

The wire protocol — every request takes an ack callback that answers `{ok:true,…}` or
`{ok:false,error:{code,message}}`, so a client never hangs:

```text
→ room:create {name, mode, code?, clientId?}   ← room:joined {ok, code, you, reconnected, room}
→ room:join   {code, name, clientId?}          ← room:joined …
→ room:quick  {name, mode, clientId?}          ← room:joined …      (fullest room with space)
→ room:sync   {}                               ← room:state {code, mode, host, count, max, players[]}
→ room:leave  {}                               ← room:left + player:left to the room
→ msg         {t:'state'|'chat'|'event'|'hello'|'bye', …}

server → room: player:joined · player:left · room:state · room:closed · room:evicted · error:msg
```

* **1 — 8 players per room.** The ninth is refused with `room_full`; a solo player is a legal room.
* **Codes** are five characters from an alphabet without `O/0` and `I/1` (so `O`→`Q`, `1`→`L` on the way
  in). Custom codes of 4–12 characters are honoured — `highway-01` becomes `HIGHWAY01`.
* **Telemetry** is whitelisted field by field (`x,y,z,yaw,speed,kmh,hp,hpMax,weapon,inCar,car,day`), so a
  client cannot smuggle `__proto__` or a 4 KB string into everybody else's session, and it is capped at
  15 Hz per player: a burst is dropped (`{ok:true,throttled:true}`), never punished.
* **Chat** is one line, 120 characters, 6 messages per 10 s, with the author stamped by the server.
* **Drops are not departures.** A phone that locks its screen keeps its seat for 6 s, and Socket.IO's
  connection-state recovery can hand the same session back inside 45 s. If recovery is impossible (a full
  reload), the browser presents the same `clientId` and the server hands the old seat over instead of
  leaving a ghost car in the road.
* **CORS is open** — any front-end may call the API and open a socket (there are no cookies on this relay and
  no secrets behind it), and the same predicate is shared by the HTTP routes and the handshake. Lock it down
  when you want to: `ALLOWED_ORIGINS="https://gemby-game.vercel.app,https://*.vercel.app"` restricts it to that
  list (wildcards matched on the parsed host, so `…vercel.app.evil.com` is refused), `CORS=strict` uses the
  built-in production list, and `localhost` / `192.168.x.x` always work for phone testing.

`lib/lobby.mjs` holds the rules (caps, codes, sanitising, rate limits, pruning) with no dependency on
Express or Socket.IO, so they are tested directly; `lib/cors-policy.mjs` holds the allowlist;
`public/js/sio.js` is the browser half — it loads the client from the server, joins or creates the room,
re-joins after a reconnect and hands envelopes to the game exactly like every other lane.

### Staying awake on Render

Free containers sleep after ~15 idle minutes. `server.js` keeps itself awake: on boot it starts a single
interval that, **every 10 minutes, sends a plain GET to its own public URL** (`/health`) using node's native
`https`/`http` — no dependencies, no cron, no third-party pinger.

```text
[keepalive] self-ping every 600s → https://gemby-game.onrender.com/health
[keepalive] ping 1 · HTTP 200 · 118 ms
```

* The URL comes from `RENDER_EXTERNAL_URL`, which **Render sets automatically**, so there is nothing to
  configure there. Elsewhere: `PUBLIC_URL`, `SELF_URL`, `KEEPALIVE_URL`, or `RENDER_SERVICE_NAME`
  (→ `https://<name>.onrender.com`).
* The interval is deliberately inside the 15-minute window; `KEEPALIVE_MINUTES` changes it, `KEEPALIVE_MS`
  is the raw override, `KEEPALIVE=0` switches it off, and `KEEPALIVE_PATH` retargets the request.
* It is honest about itself: `/health` reports `keepalive: {enabled, url, intervalMs, pings, failures,
  lastStatus, lastAt, lastError}`, so you can confirm from a phone that the container is being woken.
* It cannot do the impossible: a container that has **already** slept cannot wake itself (nothing is running
  to send the request), and a free instance is still recycled — the interval simply keeps an awake instance
  awake. If a deploy has been idle for hours, open the URL once, or add Render's own cron/uptime check as a
  belt-and-braces backup.
* Failures never touch the game: a timeout, a refused connection or a 500 is counted, warned about once, and
  ignored — the timer is `unref()`-ed, so it never keeps a shutting-down process alive.

### Where the rooms live

Play does not need any of this any more — it is here because the fallbacks still use it. The Supabase
Realtime lane keeps nothing: messages exist for the length of a broadcast.

The Socket.IO lane (`npm start`) and the plain WebSocket lane (`npm run relay`) keep rooms in the process. The
polling lane — the one that runs on Vercel, where there are no sockets — used to keep them in the lambda's
module scope, which means two players only saw each other if the platform happened to put them on the same warm
instance.

When Supabase is configured, **the server keeps rooms in Postgres instead**: `lib/room-store.mjs` inserts
each message into `public.room_messages` (room, author, jsonb payload, timestamp) and reads the last 9
seconds back, so every instance and every lambda shares one room. Stale rows are swept by the relay itself,
guarded by an RLS delete policy that only allows rows older than two minutes. If the database stops
answering, the store degrades to the in-memory lane and records the failure, which `/api/health` reports:

```json
{ "ok": true, "supabase": { "configured": true, "url": "https://….supabase.co", "reachable": true },
  "relay": { "backend": "supabase", "writes": 118, "reads": 611, "fallbacks": 0 } }
```

`/api/health?deep=1` also asks the Supabase project itself (`auth/v1/health`), so a deployment can tell
"the variables are set" apart from "the variables actually work". The Node server prints the same probe at
boot.

## ▲ Deploy to Vercel

```bash
vercel            # framework preset: Other
```

`vercel.json` sets `buildCommand: npm run build` (copies `public/` → `dist/`), ships `api/room`,
`api/health` and `api/config`, and disables caching on the API. Add `SUPABASE_URL` and
`SUPABASE_ANON_KEY` in *Project → Settings → Environment Variables* (all three environments), then
**redeploy** — env changes only apply to new deployments. The build log prints
`supabase accounts: configured (url from SUPABASE_URL)` when they were picked up, and
`dist/config.json` is generated from them as a fallback. Online play on Vercel uses Supabase Realtime (or the
polling relay if Supabase is not configured); for 15 Hz Socket.IO rooms run `npm start` on a host that keeps a
socket open — Render, Railway, Fly, a VPS — and point the game at it with `?relay=https://your-server`, or set
`window.__OUTRUN_RELAY__` from the deployment's own config.

The room server has its own walkthrough: [`docs/DEPLOY-RENDER.md`](docs/DEPLOY-RENDER.md) (ports, CORS, the
self-ping, how to confirm it from a phone), with `render.yaml` as a one-click blueprint.

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
  js/net.js           multi-transport multiplayer client (socketio → supabase → ws → poll)
  js/sio.js           Socket.IO lane: client loader, room join/create, re-join on reconnect
  js/hud.js           HUD, radar scope, paginated workbench, chat, toasts
  js/items.js         item + drop-table catalogue (materials, medkits, fuel cans, gear)
  js/loot.js          physical loot drops: meshes, magnet drift, pickup, expiry
  js/inventory.js     backpack model + hotbar/backpack UI
  js/recipes.js       15 staples + 1000 generated recipes (seeded, effects)
  js/preview.js       dependency-free 2D avatar portrait for the home screens
  js/graphics.js      the quality tier table every renderer setting reads from
  js/fullscreen.js    fullscreen API wrapper: buttons, Alt+Enter, iOS fallback
  js/orientation.js   auto landscape during a run; portrait home
  js/arcade.js        arcade hub, sandboxed game player, records + ratings
  js/arcade-stats.js  Supabase ratings/runs/leaderboards (local fallback)
  js/materials.js     procedural PBR material kit, quality tiers
  js/effects.js       pooled particle bursts (budgeted per device)
  js/audio.js         procedural WebAudio engine/wind/impacts
api/                  Vercel functions: /api/room, /api/health, /api/config, /api/admin
lib/admin-auth.mjs    server-side owner check (Supabase token → username → allow-list)
lib/room-store.mjs    room relay storage: Supabase room_messages, memory fallback
lib/lobby.mjs         rooms, codes, telemetry/chat limits, seat recovery — no dependencies
lib/cors-policy.mjs   the origin allowlist shared by express and the socket handshake
lib/keepalive.mjs     the 10-minute self-ping that keeps a free container awake
games/                community games: <slug>/{game.json,icon.svg,index.html,…,js}
games/star-battle/gl.js     WebGL renderer for Star Battle (hull mesh, sky, sprites, sized solids)
games/star-battle/interior3d.js  the 3D ship interior: decks, warp core, a figure per crewed station
games/iron-tide/sea3d.js    WebGL renderer for Iron Tide (ocean, hulls, sky, sprites)
games/_shared/sdk.js  the postMessage SDK every community game loads
scripts/scan-games.mjs  validates every game.json and regenerates games/index.json
supabase/schema.sql   tables, RLS policies, friend RPCs, owner gate, bans, signup trigger
server.js             Express + Socket.IO realtime host (npm start, PORT || 8080, 0.0.0.0)
render.yaml           Render blueprint: build, start, health check, keep-alive env
server.mjs            static + WebSocket + polling relay + config endpoint (npm run relay)
tests/                headless suites (npm test)
docs/DESIGN.md        game design document
docs/DEPLOY-RENDER.md the room server on Render: ports, CORS, staying awake
```

## 🧪 Tests

`npm test` copies the browser modules into a shim lane and runs the suites in `tests/run-all.mjs` with no browser:
(`tests/run-all.mjs` is the list; `node tests/build.mjs` must run first after any edit).

That lane stubs `WebGLRenderer.render()`, which is exactly why a scene the real three.js refuses used to pass every
test and fail on a phone. `tests/render-real.test.mjs` closes the hole: it builds the **real**
`THREE.WebGLRenderer` on a recording WebGL context and drives every mode through the same loop
`requestAnimationFrame` drives, so the whole JS render pipeline runs — program setup, attribute binding, textures,
shadow passes — and it audits the scene for the things a GPU rejects (a drawable with no positions or a NaN in
them, an index past its buffer, a >65k mesh in a 16-bit index, a textured material with no UVs, a hole in a
material array). FUEL RUN is the first case in it, because that is the run the report named.

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
* **arcade** — catalogue scan + merge (community manifests validated, featured-first ordering), the
  sandboxed iframe contract, and the hub's ratings/records paths.
* **games under Vercel's URL rules** — a static server that applies `cleanUrls` + `trailingSlash: false`
  (`/games/iron-tide/index.html` → `/games/iron-tide`, no slash) and proves the ship still loads its own
  files there — the trailing slash that was missing was the whole "the game did not start" bug.
* **games under Vercel's URL rules + full page load** — a static server that applies `cleanUrls` +
  `trailingSlash: false`, then a browser-like loader: it fetches the game page over HTTP, runs its inline
  `<base>` pin, fetches and executes every `<script src>` in order, and asserts `arcade:ready` reached the
  parent — with the dock built and the wallet painted, inside a storage-locked (sandboxed) origin. It also
  removes the pin and proves the whole game dies, so the regression cannot come back quietly.
* **fleet builder + auto landscape** — Iron Tide's hulls, modules, jets, slot limits, dock purchases, enemy
  scaling and payouts, plus a full booted game: sail, fire, win, lose, return to dock; and the orientation
  helper's idempotence, listeners and landscape state.
* **fast boot + portrait home + supabase relay** — the real import graph of `main.js` (no three.js, no
  game, < 200 KB), the 2D portrait preview, portrait-home/landscape-run orientation, the room store against
  a fake PostgREST (insert shape, time window, author filter, degradation when the DB is down), and a live
  server: compression, `ETag`/304, cache headers, `/api/health`, `/api/config` and the relay round trip.
* **graphics tiers + fullscreen** — the tier table (monotonic pixel cap / shadow size / draw distance /
  props / clouds), auto-detect, a real `Game` booted at all four tiers (4K shadows, PBR env, rim + fill
  lights, fog, avatar detail, cloud sprites drifting and wrapping), material/segment scaling, and the
  fullscreen module: enter/exit, the keyboard shortcuts, chat-field safety, and the iOS refusal path.
* **lobby + matchmaking codes** — the rules on their own: codes generated/typed/misread, custom room
  names, the 1–8 cap, quick play preferring the fullest room, host hand-over, prototype-poisoning and
  clamping in telemetry, the 15 Hz budget, chat trimming/flooding, held seats and reconnected ghosts.
* **CORS policy** — the shipped origin allowed, eight lookalikes refused, localhost and LAN phones,
  `ALLOWED_ORIGINS` extras and wildcards, and the Socket.IO handshake callback.
* **render keep-alive** — URL resolution (`RENDER_EXTERNAL_URL` and the manual overrides), the interval and
  its clamps, the request itself against a real local server (200, 503, refused, timeout, bad URL), the loop
  firing and stopping, `KEEPALIVE=0`, and a dead target counting failures without ever throwing.
* **socket.io server, live** — a real `node server.js` on a real port: `/health`, `/api/rooms`, the served
  client, CORS echo/refusal/preflight, then real clients over a WebSocket — create, join, telemetry,
  throttling, chat, refusal of impostors, the eight-player cap, session recovery after the transport is
  killed, ghost-seat reclaiming, SIGTERM shutdown.
* **iron tide boot** — the ship, booted headlessly: it announces `arcade:ready` *before* it builds the dock
  (so a broken dock cannot black out the canvas), fills the dock and the wallet, sails a sortie, fires,
  ends the run and reports the score — in a few milliseconds.
* **p2p protocol / rooms / lane** — the WebRTC protocol on its own (validation, clamping, host election),
  then a real `P2PRoom` with a fake `RTCPeerConnection`: election, offer/answer/ICE, star relaying,
  host-stamped authorship, junk dropped, a host leaving; then two real `Net` instances over a real socket,
  proving the lane glue — signalling on its own Supabase topic, telemetry browser-to-browser, a quitting
  host, a dead topic and `?relay=`.
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
(fps, entities, position, relay mode).

**Analytics — players and games.** The console opens with a read of the shared `game_runs` log: total
runs, runs in the last 24 hours, distinct signed-in players, guest runs, games played and the best score
in the log, plus a per-game table (runs, players, best, average, how long ago) sorted by how much it is
actually being played. It is one `select … limit 500` a minute, folded by `summarizePlays()` in
`public/js/arcade-stats.js` — a pure function, so the numbers are testable without a database.
`window.__outrunErrors` and the owner console's runtime log keep the last few client failures with their
stacks: a `cannot read properties of undefined` becomes a bug report instead of a frozen screen. The **players in room** list lets you teleport to, kick or ban
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
