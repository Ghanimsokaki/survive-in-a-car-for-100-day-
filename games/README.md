# ARCADE — community games

Every game in the arcade is a folder in this directory. Adding one is a **pull
request** — no server, no database, no upload form.

## Add a game in four steps

1. Copy `_template/` to a new folder. The folder name **is** your game id:
   `games/my-game/` → `{"id": "my-game"}`. Lowercase letters, digits and `-`
   only, 2–32 characters.
2. Fill in `game.json` (see the schema below) and drop your `icon.svg` next to it.
3. Write the game. Plain HTML/JS/canvas — no build step, no imports from the
   hub. Load the SDK with `<script src="../_shared/sdk.js"></script>`.
4. Open a PR that adds the folder. `npm run games` regenerates
   `games/index.json`; CI runs `npm test`, which validates every manifest.

Merged on `main` = playable in the arcade for everyone.

## `game.json`

| field | required | notes |
|---|---|---|
| `id` | ✅ | must match the folder name |
| `title` | ✅ | shown on the card, ≤ 40 chars |
| `author` | ✅ | your username, lowercase |
| `blurb` | ✅ | one line, ≤ 160 chars |
| `version` | — | `x.y.z`, default `1.0.0` |
| `entry` | — | default `index.html`, must stay inside your folder |
| `icon` | — | default `icon.svg`, square, keep it under 100 KB |
| `tags` | — | up to 5 short slugs (`solo`, `co-op`, `horror`…) |
| `accent` | — | `#rrggbb`, tints your card |
| `players` | — | free text, e.g. `1-4` |
| `featured` | — | `true` pins the card to the top row (owner decides) |

Whole folder limit: **18 MB**. Keep it small — phones load this over 4G.

## The SDK

Games run in `<iframe sandbox="allow-scripts">`: **no DOM access to the hub, no
localStorage, no Supabase session, no network shortcuts.** All you can do is
talk through `Arcade`:

```js
Arcade.ready()                                  // you can accept input now
Arcade.on('start', (player) => {})              // { name, color, room, custom }
Arcade.state({ day: 3, status: 'IN RUN' })      // optional live chip on the card
Arcade.score({ score: 1240, seconds: 96, won: true, meta: 'day 12' })
Arcade.close()                                  // back to the arcade
Arcade.fit(canvas, 2)                           // DPR-correct canvas sizing
```

`Arcade.player` is filled in after `arcade:init`. Opening
`games/<slug>/index.html` directly still runs the game standalone (handy for
development) — the SDK falls back to a local start event.

## House rules

- No external `<script>` or `fetch` to third-party hosts. Self-contained only.
- No `eval`, no `document.write`, no `window.open`.
- Report a score you actually earned; the owner can unpublish anything.
- Keep it playable on a phone in landscape: `Arcade.fit()` + `touch-action:none`.
