# Barrage Handoff

This file is for a future assistant or a fresh chat with no context. Read this before changing code.

## Project Goal

`barrage` is a 2D/2.5D multiplayer trebuchet battle game. Players defend a king and attack with trebuchets. The game uses a Blender-authored GLB level and a browser-authoritative simulation.

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

API (Cloudflare Pages Functions)
  ├── /api/auth    — login, register, quickplay (JWT via jose)
  ├── /api/lobby   — list open sessions
  ├── /api/sessions — WebRTC signaling (offer/answer/ICE)
  └── /api/stats   — leaderboard, round results, enemies
```

The game worker (`src/game-worker/index.js`) is compiled by Vite into `public/game-worker.js`.
**Always run `npm run build` after changing any file in `src/game-worker/`.**

## Deployment: Cloudflare Pages + D1

- **Static files + Functions**: Cloudflare Pages (free tier)
- **Database**: Cloudflare D1 (SQLite-compatible, free tier)
- **Domain**: barrage.pages.dev
- **Auto-deploy**: push to `main` branch → Cloudflare builds and deploys automatically
- Build command: `npm run build` (runs Vite to compile game worker)
- Output directory: `public`
- Functions directory: `functions/` (picked up automatically by Pages)

### D1 Database
- Database name: `barrage`, ID: `585041a6-feb1-4625-8b41-2b666543eba4`
- Schema: `schema.sql` — run once with `npx wrangler d1 execute barrage --remote --file=schema.sql`
- For new tables/columns: add to `schema.sql` and re-run (uses `IF NOT EXISTS`)
- For one-off migrations: `npx wrangler d1 execute barrage --remote --command "ALTER TABLE ..."`

### Environment Variables (set in Cloudflare Pages dashboard)
- `JWT_SECRET` — token signing secret

## Run Commands

```sh
npm install
npm run build          # compiles src/game-worker/index.js → public/game-worker.js

# Local dev (Cloudflare Workers runtime, D1 local):
npx wrangler d1 execute barrage --local --file=schema.sql  # first time only
npm run dev            # wrangler pages dev → http://localhost:8787
```

Note: `wrangler` is a local devDependency — use `npm run dev` or `npx wrangler`, not `wrangler` directly.

## Main Files

- `functions/api/[[catchall]].js` — Cloudflare Pages Function entry, mounts Hono app
- `src/server/auth.js` — login, register, quickplay routes (Hono + D1 + jose + bcryptjs)
- `src/server/lobby.js` — session listing
- `src/server/signaling.js` — WebRTC offer/answer/ICE signaling (2min stale expiry)
- `src/server/stats.js` — leaderboard, round results, enemies
- `src/server/middleware.js` — `requireAuth` middleware, `createAuthToken` (jose)
- `src/server/db.js` — stub only (D1 accessed via `c.env.DB` in each route)
- `wrangler.toml` — Cloudflare config, D1 binding, nodejs_compat flag
- `schema.sql` — D1 table definitions
- `src/game-worker/index.js` — authoritative physics simulation (Babylon NullEngine + Havok)
- `public/client.js` — browser renderer (Babylon), VirtualSocket, input handling
- `public/config.js` — shared gameplay/render/input config
- `public/rtc.js` — WebRTC peer connection classes (RtcHost, RtcGuest)
- `public/assets/level1.glb` — current default Blender level (levels 1–4 exist)
- `itch/index.html` — itch.io upload page (iframe to barrage.pages.dev)

## API Stack

Routes use **Hono** (Express-like, works in Cloudflare Workers). D1 accessed via `c.env.DB`:
```js
// Single row
const row = await c.env.DB.prepare("SELECT * FROM t WHERE id = ?").bind(id).first()
// All rows
const { results } = await c.env.DB.prepare("SELECT * FROM t").all()
// Write
const result = await c.env.DB.prepare("INSERT ...").bind(...).run()
result.meta.last_row_id  // insert ID
result.meta.changes      // rows affected
// Batch
await c.env.DB.batch([stmt1, stmt2])
```
Auth uses `jose` (not jsonwebtoken). Passwords use `bcryptjs` (not bcrypt).

## Database Tables

- `users` — registered and guest accounts (is_guest=1 for quickplay, display_name for shown name)
- `game_sessions` — WebRTC signaling sessions (status: waiting→signaling→active→ended)
- `ice_candidates` — ICE candidate exchange
- `game_results` — legacy (unused)
- `player_stats` — battles_won, battles_lost, wars_won, wars_lost per registered user
- `war_opponents` — who defeated whom in wars
- `round_results` — one row per round, UNIQUE(session_id, round_number) prevents double-counting

## Session Lifecycle

- Created on `POST /api/sessions` (host)
- Removed from lobby immediately when status set to `active` (client calls this on match start)
- Ended on `POST /api/sessions/:id/end` (called via `keepalive: true` fetch on host's `beforeunload`)
- Stale sessions (waiting/signaling, >2min) purged on next session creation

## Usernames

Players' real usernames (stored in `sessionStorage.barrage_username`) are passed to the game worker:
- Host: sent in `playerConnect` message directly
- Guest: sent as `{ type: "setUsername", username }` through WebRTC DataChannel on connect; host intercepts and posts `setUsername` to worker
- Worker stores them in `playerUsernames[role]` and includes `displayName`/`opponentDisplayName` in `welcome` and `matched` messages
- `playerId` remains `Player_1`/`Player_2` internally (used for side detection); `displayName` is used only for display

## Networking Protocol

Worker → client messages:
- `welcome` — sent on connect, includes `playerId`, `displayName`
- `lobby` — waiting for opponent
- `matched` — both players connected, includes `playerId`, `opponentId`, `displayName`, `opponentDisplayName`
- `state` — physics state broadcast each tick
- `event` — game events (kingHit, fire, sounds)
- `roundEnded` — round winner/loser, scores, optional `matchWon`, optional `forfeitLoser`
- `levelChanged` — new round loading, optional `forfeitLoser` for surrender message
- `matchOver` — match complete
- `ping` — lag compensation probe

Client → worker messages:
```js
{ type: "input", action, ...payload }
```
Actions: `reset`, `dragStart`, `dragMove`, `dragEnd`, `aimStart`, `aimMove`, `aimRelease`, `pong`
Special: `{ type: "input", action: "surrender", surrenderType: "battle"|"war" }`
Connect: `{ type: "playerConnect", role, username }` (host) / `{ type: "setUsername", username }` via WebRTC (guest)

## Surrender

- **Surrender Battle**: `handleSurrenderBattle(role)` — calls `recordRoundWin(loserPlayerId)`, sets `room.pendingForfeitLoser`, which is included in next `levelChanged`. Winner sees win animation + camera pan; next level shows surrender message.
- **Surrender War**: `handleSurrenderWar(role)` — broadcasts `roundEnded` with `matchWon: true` then `matchOver`. Equivalent to disconnect forfeit without disconnecting.
- Buttons visible only when `isMatched` is true; hidden on `roundEnded`, shown again on `levelChanged`.

## Physics

Havok runs in the game worker browser context (not Node). Initialized with:
```js
havokInterfacePromise ??= HavokPhysics(); // browser auto-fetches WASM
```

2D plane lock: Z position forced to `originZ`, Z linear velocity zeroed each tick.
Trebuchets: only X movement allowed, Y/Z locked to origin.
Blocks/kings use magnetic drag (force-based). Missiles use direct position sync.

## Disconnect Handling

- Guest disconnects → worker broadcasts `roundEnded` with `matchWon: true` to host ✓
- Host disconnects → guest's WebRTC drops → `socket close` fires → if `matchStarted && !matchOver`, guest sees win screen ✓
- `matchStarted` flag in client.js stays true through round transitions (unlike `isMatched`)
- Host page unload → `fetch /api/sessions/:id/end` with `keepalive: true` removes session from lobby

## UI

- Player portrait images top-left (player 1) and top-right (player 2), 80px tall
- Player display names positioned next to portrait bottom using `getBoundingClientRect()`, same X as crowns
- Font: Asimovian (Google Fonts) at 18px
- Media controls panel (sound + surrender buttons) — positioned below portrait, switches sides with player parity
- "The War is over\n[winner name] has won" match end screen

## Leaderboard / Stats

- `POST /api/sessions/:id/result` — either player reports each round result
- `GET /api/leaderboard` — all registered (non-guest) players, sorted by wars_won
- `GET /api/me/enemies` — current player's defeated opponents
- Guests (is_guest=1) are excluded from stats tracking
- `UNIQUE(session_id, round_number)` prevents double-counting when both players report
- Terminology: Battles = rounds, Wars = full matches

## Login / Lobby Pages

Both `login.html` and `lobby.html` have:
- Full-screen Babylon.js background scene (random level from levels 1–4)
- Same camera position as game (computed via `computeCamPos` using config viewport bounds)
- `rgba(0,0,0,0.45)` dim overlay, `title.webp` banner
- UI cards with `backdrop-filter: blur(8px)` and `rgba(20,20,30,0.75)` background

## Asset Caching

Controlled by `BARRAGE_CONFIG.cacheAssets` in `public/config.js`:
- `false` (default) — `Cache-Control: no-store` (good for dev)
- `true` — GLBs, images, sounds get `public, max-age=3600` (set for production)

## Quick Verification

```sh
node --check public/client.js
node --check src/game-worker/index.js
npm run build
```

## Next Session: AI Opponent

Goal: add a "Play vs AI" option when no human opponent is available in the lobby.

Design from scratchpad:
- AI acts as a second client/player, providing equivalent mouse/touch input
- Reads object positions from the game state (same data the renderer uses)
- AI actions (in order): load nearest missile onto trebuchet, aim for opponent king, fire; then load next missile and fire
- Config variables for AI speed: ball drag speed, trebuchet loading speed
- AI sees the world the same way the player does — no special physics access

Key consideration: since the host runs the game worker, the AI can run entirely in the host's browser as a second input source alongside the player. No server changes needed.
