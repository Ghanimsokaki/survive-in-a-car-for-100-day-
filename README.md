# 100 Days Outrun — Highway Survival

A complete, single-file browser survival game: 100 days of post-apocalyptic highway, one car, four failing
systems, a workbench full of scrap and a sky that spins.

**▶ Play:** open `index.html` in any modern browser (double-click works — no server, no build step, no network calls).

---

## What's in the repo

| File | What it is |
|---|---|
| `index.html` | The whole game — HTML, CSS, ~5 500 lines of vanilla JS, all art drawn procedurally on canvas, all sound synthesised with WebAudio. |
| `GDD.md` | The game design document: pillars, formula tables, 100-day event matrix, economy, UI spec, technical design. |
| `LICENSE` | Apache 2.0 |

Nothing is fetched at runtime: no font CDN, no sprite sheets, no analytics — and no Tailwind CDN either. The original
brief asked for "Tailwind + custom CRT/neon effects"; to keep the build truly single-file and offline-capable, the
styling is a hand-written utility-style CSS layer (design tokens, panel/bracket primitives, state classes) with the
CRT scanline, neon glow and HUD chrome built on top. Open the file with no network and it looks identical.

---

## Controls

| Key | Action |
|---|---|
| `W` / `↑` | Accelerate |
| `S` / `↓` | Brake, then reverse |
| `A` `D` / `←` `→` | Steer |
| `SPACE` | Deploy / retract ground anchors |
| `E` (hold) | Scavenge a pit stop · power a generator · process fuel · trade at the Oasis |
| `F` | Swing the equipped weapon (auto-aims the nearest threat) |
| `B` | Mobile workbench (craft, repair, upgrade) |
| `R` | Emergency field patch (2 scrap + 1 steel) |
| `G` | Crack a fuel can (+10 L) |
| `M` | Mute |
| `P` / `ESC` | Pause |

Touch devices get steering/throttle pads plus the same action buttons in the HUD.

---

## How a run works

1. **Day 1** starts **inside the car** on Oakhaven's dead main street. Tank: 5 L. Objective: salvage **20 L** from
   the jerry cans in the town, then drive through the storm gate.
2. Every day is a set distance. Finishing it autosaves, advances the calendar and posts tomorrow's weather.
3. Pull over at **pit stops** (fuel stops, garages, diners, motels, military checkpoints, warehouses, mines) and hold
   `E` to strip them — but about half are watched, and looting one can spring an ambush.
4. Spend scrap at the **mobile workbench**: four weapon tiers (Scrap Pipe Bat → Machete → Leaf Spring Katana →
   Damascus Scrap Broadsword), rig upgrades (armor, tires, fuel cell, coolant, ram bumper, sand filter, acid seal,
   hurricane grill), four anchor tiers, and repairs.
5. When the forecast says **vortex**, slow down and hit `SPACE`. Anchors multiply the storm's pull down to 22 % / 14 %
   / 9 % / 5 % by tier, but the spikes take integrity damage the whole time they hold.
6. 15 scripted milestones punctuate the road (generator defence, roadblock breach, convoy loot, two bosses, refinery
   siege, steel mill gauntlet, mountain pass, Oasis trading post, forge duel, flash flood, grid lock, escort, and the
   Category 5 hypercane on Day 100).
7. Chassis at zero ends the run — **Retry Checkpoint** reloads the last dawn.

Difficulty (`Drifter` / `Road Warrior` / `Dead Road`) changes damage taken, fuel burn, loot quality and anchor strain.
Progress, preferences and mute state live in `localStorage`.

---

## Feature checklist

- Top-down driving with suspension-ish feel: steering authority curve, lateral grip, off-road penalty, wet/mud
  handling, tire-dependent top speed.
- Tornado simulation with directional pull, lift, debris, swirling multi-band funnels, eye lightning and a
  350-unit vortex radius; Categories 1–5 plus a persistent Cat-5 hypercane finale.
- Anchor spike system with four tiers, integrity drain, hard-deploy tire damage and a physical pin on the chassis.
- Live radar sweep with vortex, pit-stop, hostile and objective blips; EMP storms degrade the scope.
- HUD: day counter + progress rail, phase/zone banner, speedometer, odometer, diagnostics matrix (fuel, chassis,
  engine, tires, heat, anchor integrity, fuel cans), weather chip with countdown, one-day forecast, mission strip.
- Workbench modal with material inventory, recipe cards, live cost validation, tier locks and repair tab.
- 5 phases, 15 milestones, 20+ scheduled weather events, procedural roadside generation, day/night tint, rain,
  dust, acid, heat shimmer, lightning, screen shake and a synthesised engine/wind/impact soundtrack.
- Autosave every dawn, manual checkpoint, abandon run, retry from checkpoint, victory statistics and rank.
- Keyboard-first, touch fallback, `prefers-reduced-motion` respected, no external assets.

---

## Screenshots & tuning

`GDD.md` §10 lists the balance levers (day length, fuel burn, anchor hold, loot tables, storm schedule, difficulty)
with their locations in the source. The game exposes `window.OUTRUN` in the console for jumping to any day or
weather event while tuning.

*Licensed under Apache 2.0 — see `LICENSE`.*
