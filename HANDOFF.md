# Barrage Handoff

This file is for a future assistant or a fresh chat with no context. Read this before changing code.

## Project Goal

`barrage` is a game-jam prototype for a 2D/2.5D multiplayer trebuchet battle. Players defend a king and attack with trebuchets. The game uses a Blender-authored GLB level and a browser-authoritative simulation.

Current design direction:
- Author level layout in Blender/GLB wherever possible.
- Server is a thin HTTP/signaling layer only — no game simulation.
- Game simulation runs in a **browser Web Worker** (the "game worker") inside the host player's browser.
- Client only sends input: pointer/touch positions and actions.
- Client renders game worker state and interpolates as little as possible for now.

## Architecture Overview

```
Host browser
  ├── client.js (renderer + input)        ← renders game, sends input to WorkerSocket
  ├── game-worker.js (compiled bundle)    ← Havok physics sim, authoritative state
  └── rtc.js (RtcHost)                   ← WebRTC DataChannel to guest

Guest browser
  ├── client.js (renderer + input)        ← renders game, sends input via WebRTC
  └── rtc.js (RtcGuest)                  ← WebRTC DataChannel to host

Server (Node.js, server.js)
  ├── /api/auth    — login, register, quickplay (JWT)
  ├── /api/lobby   — list open sessions
  ├── /api/sessions — WebRTC signaling (offer/answer/ICE)
  └── /api/stats   — leaderboard, round results, enemies
```

The game worker (`src/game-worker/index.js`) is compiled by Vite into `public/game-worker.js`.
**Always run `npm run build:worker` after changing any file in `src/game-worker/` or `server/`.**

## Run Commands

```sh
npm install
npm run build:worker   # must run after any server/ or src/game-worker/ change
npm start              # serves on http://localhost:3000
```

Hard refresh browser after code changes (`Cache-Control: no-store` on all responses).

## Main Files

- `server.js` — thin Express HTTP server, mounts API routers, serves `public/`
- `src/game-worker/index.js` — authoritative physics simulation (Babylon NullEngine + Havok), compiled to `public/game-worker.js`
- `public/client.js` — browser renderer (Babylon), WebSocket-compatible VirtualSocket, input handling
- `public/config.js` — shared gameplay/render/input config (imported by both worker and client)
- `config/server.js` — server-only physics/world constants
- `public/rtc.js` — WebRTC peer connection classes (RtcHost, RtcGuest)
- `src/server/auth.js` — JWT auth, login, register, quickplay
- `src/server/lobby.js` — session listing
- `src/server/signaling.js` — WebRTC offer/answer/ICE signaling
- `src/server/stats.js` — leaderboard, round result recording, enemies list
- `src/server/db.js` — better-sqlite3 database setup and migrations
- `public/assets/level1.glb` — current default Blender level (levels 1–4 exist)

## Database

Uses **better-sqlite3** (synchronous SQLite). DB file: `barrage.db` in project root.

Tables:
- `users` — registered and guest accounts (is_guest=1 for quickplay)
- `game_sessions` — WebRTC signaling sessions
- `ice_candidates` — ICE candidate exchange
- `game_results` — legacy (unused)
- `player_stats` — battles_won, battles_lost, wars_won, wars_lost per registered user
- `war_opponents` — who defeated whom in wars
- `round_results` — one row per round, UNIQUE(session_id, round_number) prevents double-counting

**NEXT TASK: Migrate from `better-sqlite3` to `@libsql/client`**

Reason: Hostinger managed Node.js hosting can't build native addons (old GLIBC/Python).
`@libsql/client` uses WASM, no native compilation, works anywhere.

Key differences to implement:
- All DB calls become async (`.get()` → `await db.execute()`, `.run()` → `await db.execute()`)
- `db.prepare(sql).get(args)` → `(await db.execute({ sql, args })).rows[0]`
- `db.prepare(sql).run(args)` → `await db.execute({ sql, args })`
- `db.prepare(sql).all(args)` → `(await db.execute({ sql, args })).rows`
- `db.transaction(fn)` → explicit `BEGIN`/`COMMIT` or `db.batch([...])`
- All route handlers and auth functions that touch DB need `async/await`
- The `db.exec()` init block (CREATE TABLE etc) needs to run before server starts: wrap in an async `initDb()` called before `httpServer.listen()`
- libsql uses `?` placeholders same as SQLite — SQL queries don't change

## Deployment Target: Hostinger Managed Node.js

- Entry file: `server.js`
- Build command: `npm run build:worker`
- Node version: 22.x
- HTTPS provided automatically via Hostinger temp domain
- **Cannot use `better-sqlite3`** — requires native compilation, fails on Hostinger's CentOS 8 environment

## Blender Naming Scheme

Gameplay objects are detected from top-level GLB transform nodes whose children contain recognized collider/visual names.

Recognized child roles:
- `ColVis`: both collider and visible mesh.
- `Collider` or `Col`: collider only.
- `Visual` or `Vis`: visual only.

Dynamic root names are detected if the root name includes:
- `block`
- `trebuche`
- `missile`
- `king`

King roots get `hits: 0` and `maxHits: 3`.

Current examples in `level1.glb` include:
- `blockL`, `blockL.001` etc.
- `blockR`, `blockR.001` etc.
- `missile`, `missile.002`, `missile.004`, `missile.006`
- `trebuche-left`
- `trebuche-right`
- `KingL`
- `KingR`
- `ground`

## Networking Protocol

Worker → client messages:
- `welcome` — sent on connect, includes `playerId`
- `lobby` — waiting for opponent
- `matched` — both players connected, game starting
- `state` — physics state broadcast each tick
- `event` — game events (kingHit, fire, sounds)
- `roundEnded` — round winner/loser, scores, optional `matchWon`
- `levelChanged` — new round loading
- `matchOver` — match complete
- `ping` — lag compensation probe

Client → worker messages (via `socket.send`):
```js
{ type: "input", seq, action, ...payload }
```
Actions: `reset`, `dragStart`, `dragMove`, `dragEnd`, `aimStart`, `aimMove`, `aimRelease`, `pong`

## Physics

Havok runs in the game worker browser context (not Node). Initialized with:
```js
havokInterfacePromise ??= HavokPhysics(); // browser auto-fetches WASM
```

2D plane lock: Z position forced to `originZ`, Z linear velocity zeroed each tick.
Trebuchets: only X movement allowed, Y/Z locked to origin.
Blocks/kings use magnetic drag (force-based). Missiles use direct position sync.

## Key Bug Fixed This Session

`server/input.js` was using `client.id` everywhere but the game worker creates clients as
`{ playerId, room }` — no `id` property. This made `object.draggedBy` always `undefined`,
so magnetic drag force was never applied and blocks couldn't be dragged.
Fix: all `client.id` → `client.playerId` in `server/input.js`.

## Disconnect Handling

- Guest disconnects → worker broadcasts `roundEnded` with `matchWon: true` to host ✓
- Host disconnects → guest's WebRTC drops → `socket close` fires → if `matchStarted && !matchOver`, guest sees win screen ✓
- `matchStarted` flag in client.js stays true through round transitions (unlike `isMatched`)

## Leaderboard / Stats

- `POST /api/sessions/:id/result` — either player reports each round result
- `GET /api/leaderboard` — all registered (non-guest) players, sorted by wars_won
- `GET /api/me/enemies` — current player's defeated opponents
- Guests (is_guest=1) are excluded from stats tracking
- `UNIQUE(session_id, round_number)` prevents double-counting when both players report
- Lobby has 🏆 Leaderboard button that toggles the panel, hiding Host/Join sections
- Terminology: Battles = rounds, Wars = full matches

## Login / Lobby Pages

Both `login.html` and `lobby.html` have:
- Full-screen Babylon.js background scene (random level from levels 1–4)
- Same camera position as game (computed via `computeCamPos` using config viewport bounds)
- Same lighting scaling (`importedLightIntensityScale`, `fallbackLightIntensity`, `exposure`, `contrast` from config)
- `rgba(0,0,0,0.45)` dim overlay
- `title.webp` banner (max-width: 400px)
- UI cards with `backdrop-filter: blur(8px)` and `rgba(20,20,30,0.75)` background

## Asset Caching

Controlled by `BARRAGE_CONFIG.cacheAssets` in `public/config.js`:
- `false` (default) — all responses get `Cache-Control: no-store` (good for dev)
- `true` — GLBs, images, sounds get `public, max-age=3600` (set for production)

## Quick Verification Commands

```sh
node --check server.js
node --check public/client.js
node --check src/game-worker/index.js
npm run build:worker
npm start
```

Server startup should log: `Barrage server running on port 3000`
Game worker logs: `[worker] Loaded levelX.glb with N gameplay objects`
