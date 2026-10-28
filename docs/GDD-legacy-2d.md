# 100 DAYS OUTRUN — Highway Survival
### Game Design Document + Technical Design (v1.0)

> **Logline.** The storm took the country. You still have the car. Keep the engine alive, strip every dead town for scrap and fuel, forge a sword out of truck suspension — and when the sky starts to spin, anchor down and hold.

| | |
|---|---|
| **Genre** | Top-down 2D survival driving / vehicle management / light melee combat |
| **Platform** | Browser — single self-contained HTML file, keyboard + mouse, touch fallback |
| **Session** | One "run" = 100 in-game days, 20–45 min for a clean run |
| **Camera** | Top-down, vehicle-centred, shake + storm pull on the frame |
| **Pillars** | ① The car is the body ② The forecast is the enemy ③ Scrap is the only currency ④ Standing still is a decision |

---

## 1. Core loop

```
                 ┌──────────────────────────────────────────────┐
                 │  DRIVE  →  day-km clock ticks, fuel burns     │
                 │    │                                          │
   pull over ──► │  SCAVENGE pit stops (hold E) → scrap/fuel     │
                 │    │                                          │
                 │  CRAFT / REPAIR at the mobile workbench (B)   │
                 │    │                                          │
                 │  WEATHER EVENT → anchor (SPACE) / outrun       │
                 │    │                                          │
                 │  RAIDERS / BOSS → strike (F) or ram           │
                 │    ▼                                          │
                 │  DAY ADVANCES → autosave → next forecast      │
                 └──────────────────────────────────────────────┘
```

Every day is a **short, readable contract**: finish *N* km of road with the four health pools (fuel, chassis, engine, tires) above zero. Story milestones override that contract with a scripted objective (defend, breach, boss, gauntlet, escort, survive).

At **Day 100** the contract inverts: stop driving, lock the anchors, and last five minutes inside the storm eye.

### 1.1 Start state — Day 1, "Awakening in the Driver's Seat"
* The run opens **inside the car**, in Oakhaven's dead main street. No on-foot phase, ever.
* Tank holds **5 L** of fumes; the objective is to salvage **20 L** from jerry cans scattered through the town.
* The **town gate** is a hard barrier (storm protocol). It slides open the moment the counter hits 20 L.
* The gate's collision is a *warning wall*, not a damage source — new players are told exactly what is missing, never punished for not knowing.

---

## 2. Vehicle model

The car is a 2D rigid body with a forward axis, lateral grip and a "condition" layer.

| Pool | Range | Feeds | Starves when |
|---|---|---|---|
| **Fuel** | 0–60 L (80 with aux cell) | throttle, engine life | burn rate; heatwaves double it |
| **Chassis / Armor** | 110 base (+25/+30/+40 plating) | death condition | collisions, storms, ramming |
| **Engine** | 0–100 % | top speed, acceleration | overheating, EMP, dust, acid |
| **Tire tread** | 0–100 % | grip, top speed, steering | speed, off-road, mud, anchors at speed |

**Handling.** Forward thrust scales with engine health; steering authority peaks at mid speed and falls away near the cap. Lateral velocity is bled off by a grip constant (halved off-road, boosted by off-road tires, cut in rain). Off-road halves the speed cap and kicks up dust.

**Failure ladder.** Losing the chassis ends the run (retry from the last dawn checkpoint). Losing fuel, tires or engine doesn't kill you — it makes the road lethal, which is where the tension lives.

**Upgrade slots** (all crafted at the bench, all permanent for the run):
arrival plating I–III · off-road tires · auxiliary fuel cell (60→80 L) · coolant loop · scrap ram bumper · sand-filter intake (dust immunity) · acid seal coat (−80 % corrosion) · hurricane reinforced grill (Cat-5 gate).

---

## 3. Anchor spikes (the signature mechanic)

| Tier | Name | Unlock | Hold (pull multiplier) | Integrity | Rated |
|---|---|---|---|---|---|
| 0 | — | start | 1.00 (no anchoring) | — | — |
| 1 | MK-I Manual Ground Spikes | Bench T1 · scrap + steel | ×0.22 | 100 | Cat 2 |
| 2 | MK-II Hydraulic Spikes | Bench T2 · steel + carbon | ×0.14 | 180 | Cat 3 |
| 3 | MK-III Heavy Hydraulic | Bench T3 · titanium + chem | ×0.09 | 280 | Cat 4 |
| 4 | MK-IV Titanium Hurricane Lock | Bench T4 · titanium + cores | ×0.05 | 400 | Cat 5 |

* **Space** deploys or retracts. Deployment is instant, but the physics settle over ~0.3 s.
* While anchored: vortex pull is multiplied by the tier's *hold*, lift is suppressed by the same factor, storm chassis damage drops by ~11 % per tier, and the car is pinned by exponential braking.
* **Cost of standing still:** the vortex grinds the spikes. Integrity drains with proximity × category × difficulty, so anchoring is a resource transaction, not a free win. Anchors also cannot hold in the open forever — the road is still moving.
* **Punish misuse:** firing spikes above 45 km/h shreds tires and buckles the brackets; the car still stops, but it will limp afterwards.

**Storm physics per frame** (radius *R*, distance *d*, proximity *p* = (1 − d/1.85R)^1.7):

```
pull   = p · cat_power · 5.8 · difficultyStorm · hold
lift   = (1 − hold) · p · cat/5        (visual + handling penalty)
damage = (cat_power/230) · p · (anchored ? 5.2 : 16.5) · skillFactor · (1 − 0.11·tier)
drain  = (cat_power/230) · p · 9 · difficultyDrain · (1 − 0.13·tier)
```

Vortex radius ≈ **350 units** at Category 3 (200 + 50 × category), which is what the radar's 3 400-unit sweep is calibrated against.

---

## 4. Crafting & the weapon progression tree

**Materials.** Scrap Metal (currency of survival) · Steel Plates (armor/anchors/repairs) · Titanium Alloy (late plating, hydraulic anchors, legendary blade) · High-Carbon Steel (leaf-spring steel) · Leather Straps (grips, tires) · Chemical Compounds (coolant, seals, super fuel) · Rare Sword Cores (Tier 4 + trade) · Fuel Cans (portable 10 L).

**Bench tiers.** T1 from the start of the run (a field kit bolted to the trunk) · T2 at Day 15 (roadblock breach) · T3 at Day 55 (steel mill) · T4 at Day 78 (forge shrine). Tier gates every recipe below it.

| Tier | Weapon | DMG | Durability | Reach | Crit | Special | Cost |
|---|---|---|---|---|---|---|---|
| 1 | Scrap Pipe Bat | 20 | 80 | 118 | 6 % | — | 6 scrap · 2 leather |
| 2 | Scrap Metal Machete | 35 | 100 | 124 | 12 % | — | 8 scrap · 5 steel · 3 leather |
| 3 | Leaf Spring Katana | 55 | 180 | 138 | 30 % | schematic (Day 30) | 10 carbon · 8 steel · 4 leather |
| 4 | Damascus Scrap Broadsword | 120 | 350 | 152 | 18 % | **armor-piercing** (×1.3 vs props, ignores raider armor) | 12 titanium · 8 carbon · 2 cores · 3 chem |

Weapons have real durability: every landed hit costs 1 point, acid rain eats blades, and a broken weapon drops you back to bare knuckles (7 DMG) until honed at the bench. Swinging is auto-aimed at the closest hostile in reach, so combat stays about positioning, not pointing.

**Repair economy.** Patch chassis +30 (3 scrap, 2 steel) · patch tires +40 (2 scrap, 2 leather) · tune engine +35 / −45 heat · weld anchors +90 · hone weapon +40 · crack a fuel can (+10 L). A **field patch [R]** spends 2 scrap + 1 steel for a small top-up on everything — the panic button.

---

## 5. The 100-day timeline

### Phase 1 — The Abandoned Outskirts (1–15)
Theme: car maintenance, fuel collection, first departure.
* **D1** Awakening in the Driver's Seat — salvage 20 L, leave through the town gate.
* **D7** The First Gas Station Lockout — hold **E** at the generator while raiders probe the car; power must reach 100 %.
* **D15** Highway Boundary Breach — smash a 7-segment concrete barricade (ram or blade) to unlock Bench T2.
* Pit stops: dead pumps, diners, garages. Hazards: dust on D3, gale on D10, **Cat 2 mini-tornado D14** (needs MK-I spikes).

### Phase 2 — The Sunken Highway (16–40)
* **D20** The Highway Collapse — 2.4 km of mud, puddles and wrecks; grip and tire test.
* **D30** The Abandoned Convoy Raid — break 3 supply crates for the **katana schematic** + high-carbon steel.
* **D40** Midway Checkpoint Boss — **Armored Raider Rig** (650 HP, charge telegraph) at the toll gate.
* Hazards: EMP storms D18/D25 (engine surges), **Cat 3 tornado D35** (needs MK-II hydraulics).

### Phase 3 — The Industrial Wastes (41–65)
* **D45** Refinery Siege — 3 assault waves interleaved with processing holds for **Super Fuel**.
* **D55** The Steel Mill Heist — thread five automated crushing gates; harvest titanium; **Bench T3**.
* **D65** The Superstorm Barrier — narrow mountain pass, crosswind, guard-rail punishment.
* Hazards: acid rain D42/D52 (hull + blade corrosion), **twin Cat 4 vortexes D60** (steel hull + MK-III).

### Phase 4 — The Desert Canyons (66–85)
* **D70** The Oasis Outpost — free full repair, then a scrap-for-parts trade terminal.
* **D78** The Sword Forge Shrine — **Forge Master** (900 HP, ground ignitions) → **Bench T4** + broadsword pattern.
* **D85** The Canyon Ridge Breakout — outrun a rising flash flood for 35 s.
* Hazards: heatwaves D68/D75/D82 (2× fuel evaporation, overheating), **D80 dust tornado** (sand-filter intake).

### Phase 5 — The Final Mile (86–100)
* **D90** The Grid Lock — 10-mile mega-jam, 28 wrecks, elite rigs.
* **D95** The Apex Convoy Escort — keep the allied rig alive for 60 s across 4 waves.
* **D100** The Category 5 Hypercane — reach the bunker, lock down, survive 5 minutes.
* Hazards: continuous rain wall, D88 Cat 3, D95 Cat 3 gale, D98 twin Cat 4, D100 **Cat 5** (250+ mph, hurricane grill + max anchors).

**Weather forecast** is published one day ahead in the HUD — that single line of information is the game's main planning tool.

---

## 6. Encounters

| Enemy | HP | Behaviour | Threat |
|---|---|---|---|
| Scavenger (on foot) | 38 | swarms the car, claws tires/chassis | attrition, blocks scavenging |
| Raider car | 70–95 | closes, rams, disengages | fuel + hull drain |
| Elite raider | 125 | faster, light armor (12 %) | drops steel/cores |
| Armored Raider Rig (boss) | 650 | armored 25 %, charges in a telegraphed line | Day 40 gate |
| Forge Master (boss) | 900 | armored 20 %, ground ignitions, heavier ram | Day 78 forge |

Ramming is a weapon: damage scales with closing velocity, and a **ram bumper** converts 20 % of the impact back into the target. Barrels cook off for 45 splash damage in a 160-unit radius — useful against packs, dangerous when you're the one parked next to them.

**Pit-stop ambush:** ~35–55 % of stops are watched. Looting one can spawn scavengers or a raider — the risk is priced into every "hold E".

---

## 7. Economy & balance

| Source | Yield (normal) |
|---|---|
| Gas station | 14–40 L fuel, 1–2 cans, 3–8 scrap |
| Garage | steel 4–8, scrap 5–10, leather, +12 % tires, +35 anchor |
| Diner / motel | leather, chemicals, 7–10 L fuel |
| Military / warehouse / mine | high-carbon, titanium, steel, occasional cores |
| Oasis bunker | 20 L, steel, titanium, chem, core chance |
| Raider kill | 2–6 scrap, 35 % can, elite steel |
| Boss kill | titanium + steel + cores |

* Fuel burn ≈ 0.075 + 0.95·(speed/max)^1.6 L/s at normal, so a 60 L tank is ~55 s of flat-out driving or ~6 minutes of cruising — roughly 3–7 days of road. A pit stop refunds 0.5–2 tanks, which makes scavenging the pacing valve of the whole run.
* **Anti-softlock:** if fuel drops below 0.4 L with no cans, the road hands you up to three emergency caches (radar-marked).
* **Difficulty:** *Drifter* (×0.68 damage, ×0.8 fuel, ×1.25 loot) · *Road Warrior* (1.0 baseline) · *Dead Road* (×1.45 damage, ×1.28 fuel, ×0.85 loot, harsher anchor drain). Difficulty is chosen per run and stored with the save.

---

## 8. UI / UX specification

```
┌─ DAY 01/100 ─ PHASE I · OAKHAVEN OUTSKIRTS ───────── SPEED 000 KM/H · ODO 0 KM ── SND ─ PAUSE ┐
│ ┌ RADAR 360 ┐   [WX CHIP]  [ OBJECTIVE ──────── progress ]  [ NEXT DAY FORECAST ]            │
│ │  sweep    │                                                                                 │
│ │  blips    │                          ┌ TORNADO WARNING ┐                                   │
│ └───────────┘                          └ DEPLOY ANCHORS  ┘                                   │
│                                                                                              │
│                                    (top-down canvas)                                         │
│                                                                                              │
│ ┌ VEHICLE DIAGNOSTICS ┐                                        ┌ WEAPON CARD ┐               │
│ │ FUEL  CHASSIS       │   [ hold-E prompt / scav bar ]          └────────────┘               │
│ │ ENGINE TIRES        │                                        ┌ DEPLOY ANCHORS [SPACE] ┐   │
│ │ anchor · heat · can │                                        │ WORKBENCH [B]  SCAVENGE│   │
│ └─────────────────────┘                                        └ STRIKE [F] ───────────┘   │
└────────────────────────────────────────────────────────────── WASD · SPACE · E · F · B · R · G · ESC ┘
```

* **Top bar** — day counter with progress rail, phase badge + zone banner, speedometer, odometer, sound and pause.
* **Top-left radar** — 3400-unit sweep with blips for vortexes (pulsing red), pit stops (cyan), hostiles (amber), goal (violet); EMP storms make the scope spark and read "SCAN OFFLINE".
* **Bottom-left diagnostics** — fuel (litres / tank), chassis, engine and tire percentages with warn/crit colour states, anchor integrity chip, heat readout, fuel-can button.
* **Bottom-right actions** — anchor toggle, workbench, hold-to-scavenge, strike. All four are duplicated by keyboard shortcuts and mirrored on touch pads.
* **Workbench modal** — inventory strip (8 materials), tier badge, tabs for Weapons / Rig / Anchors / Repairs, recipe cards with live "have/need" cost lines and lock reasons.
* **Feedback language** — CRT scanlines, neon corner brackets, damage flash, hull floaters, toast stack (loot / warn / bad / good), screen shake tied to impact energy.

---

## 9. Technical design

* **Single file.** `index.html` embeds CSS, ~5 500 lines of vanilla JS and all art. Zero external requests: no CDN, no fonts, no images, no network — it runs from `file://`.
* **Renderer.** One 2D canvas at device-pixel-ratio cap 2, with a camera transform (`zoom 0.5–1.15` by viewport). Everything is procedurally drawn: layered asphalt (aggregate noise, patches, expansion joints, tire polish), guard rails, utility poles with sagging wires, ridge silhouettes, buildings with rooftop units, 20+ prop types, the car mesh with modular armor/kanopy anchors, and multi-band vortexes.
* **Streaming.** The world is generated in 230-unit chunks ahead of the camera and culled behind it; pit stops are placed every 1.5–2.3 km with phase-weighted building types.
* **Loop.** Fixed-ish `requestAnimationFrame` delta clamped to 50 ms. Update order: input → vehicle physics → enemies → ally → weather → vortexes → anchors → scripted event → scavenging → pickups → particles → collisions → journey/day clock.
* **State & saves.** A single `S` object; localStorage save written at every dawn, on pause-save, on milestone and on tab blur. Save holds day, km, pools, materials, weapons + durability, blueprints, upgrades, flags, stats and difficulty. Versioned key, auto-discarded on mismatch.
* **Audio.** WebAudio synthesis only: two detuned oscillators + lowpass for the engine (pitch tracked to speed), filtered noise for wind/rain, generated buffers for impacts/thunder and short tones for UI. Mute persists.
* **Accessibility.** Keyboard-only playable, `prefers-reduced-motion` kills animation, aria labels on the canvas and icon buttons, colour never the only signal (icon + text + bar), touch controls auto-detected for coarse pointers.
* **Debug surface.** `window.OUTRUN` exposes state and the day/milestone/weather helpers for automated smoke tests — deliberately undocumented in-game.

---

## 10. Balance levers (for future tuning)

| Lever | Location | Effect |
|---|---|---|
| `CFG.distanceScale` (3) / `CFG.routeKm` (8) | top of script | how fast days tick, and the odometer's road-km multiplier |
| `DAY_BASE_KM` (1.8) | config | day length floor |
| fuel burn coefficients | `updateVehicle` | survival pressure |
| `anchorHoldFactor` / drain | anchors block | storm safety curve |
| `ZONE_POOL` / loot switch | world gen | material economy |
| `SCHEDULED_STORMS` | weather table | scripted difficulty spikes |
| `DIFFICULTY` object | config | one-line global rebalance |

---

## 11. Out of scope (v1)

Multiplayer, on-foot exploration, crafting of buildings, vehicle part swapping per-slot visuals, save slots beyond one, mobile gesture steering (touch uses buttons). Procedural story beats beyond the 15 scripted milestones.
