# Barrage

Barrage is a 2-player PVP browser game for web and mobile. Each player protects a king with movable defensive blocks while launching projectiles from a trebuchet at the other side.

Production is currently deployed at:

```text
https://barrage.pages.dev/
```

## Current Stack

- Frontend: static browser app in `public/`
- Game rendering: Babylon.js
- Browser game simulation worker bundle: `public/game-worker.js`
- Worker source: `src/game-worker/index.js`
- API runtime: Cloudflare Pages Functions with Hono
- API routes: `functions/api/[[catchall]].js`
- Database: Cloudflare D1, bound as `DB`
- Local/dev tool: Wrangler

The old Node server files are still present for shared game logic and migration history, but local development now starts through Wrangler Pages, not `node server.js` or `npm start`.

## Requirements

- Node.js
- npm
- Wrangler from project dev dependencies

Install dependencies:

```bash
npm install
```

## Start Locally

Build the browser game worker bundle, then start Cloudflare Pages locally:

```bash
npm run build
npm run dev
```

Wrangler serves the app on:

```text
http://localhost:8788
```

Use a different port if needed:

```bash
npm run dev -- --port 8790
```

## Local Database

The app uses Cloudflare D1 through the `DB` binding in `wrangler.toml`.

Initialize or update the local D1 database schema:

```bash
npx wrangler d1 execute barrage --local --file=schema.sql
```

Inspect local D1 tables:

```bash
npx wrangler d1 execute barrage --local --command='SELECT name FROM sqlite_master WHERE type = "table" ORDER BY name;'
```

Use `--remote` only when you intentionally want to operate on the deployed Cloudflare D1 database:

```bash
npx wrangler d1 execute barrage --remote --file=schema.sql
```

## Common Commands

```bash
npm run build
```

Builds `src/game-worker/index.js` into `public/game-worker.js`.

```bash
npm run dev
```

Starts Cloudflare Pages locally with static files from `public/`, Pages Functions from `functions/`, and local D1 bindings.

```bash
npm run deploy
```

Deploys `public/` to Cloudflare Pages.

## Project Structure

```text
public/                  Static browser app served by Cloudflare Pages
public/index.html        Main game page
public/client.js         Browser client
public/game-worker.js    Built browser worker bundle
public/assets/           GLB levels, generated chunks, WASM, audio, and images
functions/api/           Cloudflare Pages Functions API entry
src/server/              Hono API route modules
src/game-worker/         Browser game worker source
server/                  Shared gameplay/simulation modules
config/server.js         Simulation tuning values
schema.sql               D1 database schema
wrangler.toml            Cloudflare Pages, D1, and compatibility config
vite.worker.config.js    Build config for `public/game-worker.js`
blender/                 Blender source files
```

## API Routes

The API is mounted under `/api` by `functions/api/[[catchall]].js`.

Current route modules:

- `src/server/auth.js`
- `src/server/lobby.js`
- `src/server/signaling.js`
- `src/server/stats.js`
- `src/server/admin.js`

Most gameplay and account routes expect the D1 schema from `schema.sql` to exist locally.

## Gameplay Assets

Level GLB files are served from:

```text
public/assets/
```

The first level is:

```text
public/assets/level1.glb
```

When editing game worker source under `src/game-worker/`, rebuild before testing:

```bash
npm run build
```

## Gameplay Plane

Gameplay uses two coordinates plus one rotation:

- `x`: horizontal gameplay coordinate
- `z`: depth/gameplay-plane coordinate
- `rot`: rotation around the Y axis in degrees

`rot: 0` means the object's imported/default upright rotation from Blender. Positive rotation is intended to mean clockwise around the Y axis from the gameplay camera's point of view.

## Blender Entity Pattern

Each gameplay object is authored as a hierarchy:

```text
Block_Wood_P1_01 (Empty / entity root)
├── Col
└── Vis
```

The empty parent name is the shared entity ID.

Child naming should stay short and consistent:

- `Col` for collider-only meshes used by simulation.
- `Vis` for visual-only meshes rendered by the client.
- `ColVis` for simple meshes that can be used for both collision and rendering.

Avoid spaces, punctuation, and symbols such as `&` in gameplay object names.

Useful entity prefixes:

- `Block_` for draggable defensive blocks
- `King_` for the fragile objective
- `Projectile_` for spherical missiles
- `Trebuchet_` for launchers
- `Boundary_` for static level bounds
- `Spawn_` for spawn points or projectile origins
- `Decor_` for non-gameplay visual objects
