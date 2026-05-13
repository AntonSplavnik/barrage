# Mode + Level Architecture Design

Replaces JSON-based level config and hardcoded round/match flow with two distinct layers: **Game Modes** (match flow, scoring, level rotation) and **Levels** (spawning, per-map hooks).

## Approach

Plain objects exported from JS modules. No classes, no inheritance. Matches the existing codebase style.

## File Layout

```
server/game/
  modes/
    classic.js            # Current game flow, extracted
  levels/
    level1.js             # Replaces level1.json
  modeRunner.js           # Drives match flow (replaces rules.js logic)
  levelRunner.js          # Loads & runs a level (replaces spawnObjectsFromConfig)
```

## Level Definition

Each level is a JS module exporting a plain object:

```js
// server/game/levels/level1.js
export default {
  arena: "levels/level1.glb",   // optional, path relative to public/assets/

  setup(spawn) {
    // Player 1
    spawn("trebuchets/basic", { x: -25, y: 1, player: 1 });
    spawn("kings/default-L",  { x: -37, y: 1.05, player: 1 });

    // Player 2
    spawn("trebuchets/basic", { x: 25, y: 1, player: 2 });
    spawn("kings/default-R",  { x: 37, y: 1.05, player: 2 });

    // Walls
    for (let i = 0; i < 4; i++) {
      spawn("blocks/fragmented-L", { x: -12, y: 1 + i * 3 });
    }

    // Missiles
    spawn("missiles/basic", { x: 0, y: 0.5 });
    spawn("missiles/basic", { x: 0, y: 6 });
  },

  hooks: {
    onRoundStart(ctx) { },
    onMissileFired(ctx, trebuchet, missile) { },
    onObjectHit(ctx, target, hitBy) { },       // requires collision detection (follow-up)
  },
}
```

### spawn(templatePath, opts)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `x` | number | 0 | World X position |
| `y` | number | 0 | World Y position |
| `z` | number | 0 | World Z position |
| `rotation` | number | 0 | Rotation in degrees |
| `player` | 1 \| 2 \| null | null | Player ownership |

Internally does what `spawnObjectsFromConfig` currently does per-entry: looks up template from registry, builds game object with physics properties, adds to `gameObjects` Map. The `spawn` function is created fresh per level load so ID counters reset.

## Mode Definition

Each mode is a JS module exporting a plain object:

```js
// server/game/modes/classic.js
export default {
  name: "classic",
  levels: ["level1", "level2"],
  roundsToWin: 3,

  winCondition: "kingKnockout",
  kingKnockoutAngle: 45,
  postWinDelayMs: 2000,
  roundEndDelayMs: 2000,

  levelOrder: "sequential",   // "sequential" | "random"

  hooks: {
    onRoundWon(ctx, winner, loser) { },
    onMatchWon(ctx, winner) { },
    onMatchReset(ctx) { },
  },
}
```

### Mode fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | required | Identifier for the mode |
| `levels` | string[] | required | Level IDs, resolved to `server/game/levels/${id}.js` |
| `roundsToWin` | number | 3 | Rounds needed to win the match |
| `winCondition` | string \| function | "kingKnockout" | Built-in key or custom `(ctx) => winner \| null` |
| `kingKnockoutAngle` | number | 45 | Degrees of tilt for king knockout (when winCondition is "kingKnockout") |
| `postWinDelayMs` | number | 2000 | Physics keeps running after round win for this long |
| `roundEndDelayMs` | number | 2000 | Total delay before next round starts |
| `levelOrder` | string | "sequential" | How next level is picked from the levels array |

### winCondition

String keys map to built-in check functions:
- `"kingKnockout"` — existing `checkKingKnockout()` logic, uses `kingKnockoutAngle`

Custom function signature: `(ctx) => { winner: "P1"|"P2", loser: "P1"|"P2" } | null`

## Runtime

### levelRunner.js

Replaces `spawnObjectsFromConfig()` and the level-loading portion of `level.js`.

```js
async function loadLevel(levelId) {
  const levelDef = (await import(`./levels/${levelId}.js`)).default;

  clearScene();

  if (levelDef.arena) {
    await loadArenaGlb(levelDef.arena);
  }

  const counters = new Map();
  function spawn(templatePath, opts = {}) {
    const count = counters.get(templatePath) ?? 0;
    counters.set(templatePath, count + 1);
    const id = `${templatePath}_${count}`;
    // ... build game object (same logic as current spawnObjectsFromConfig per-entry)
    gameObjects.set(id, object);
    // ... set up loadTargets for trebuchets
  }

  levelDef.setup(spawn);
  createPhysicsBodies();

  return levelDef;
}
```

### modeRunner.js

Replaces `rules.js`. Drives the match lifecycle.

State:
- `activeMode` — the current mode definition
- `activeLevel` — the current level definition (returned from levelRunner)
- `levelIndex` — current position in the mode's level list

Public API:
- `startMode(modeDef)` — initializes match state, loads first level
- `checkRoundEnd()` — called each tick (replaces `tryRecordRoundWin()`)
- `resetMatch()` — called on client reset input
- `resetRoundState()` — soft reset within a round (replaces `resetGameState()`)

```js
async function startMode(modeDef) {
  activeMode = modeDef;
  levelIndex = 0;
  gameState.roundNumber = 1;
  gameState.scores = {};
  gameState.matchOver = false;
  gameState.paused = false;

  activeLevel = await loadLevel(modeDef.levels[0]);
  activeLevel.hooks?.onRoundStart?.(ctx);
}

function checkRoundEnd() {
  // resolve winCondition — string key or custom function
  // on win: update scores, broadcast roundEnded
  // call activeMode.hooks?.onRoundWon?.(ctx, winner, loser)
  // after delay: load next level or end match
  // call activeLevel.hooks?.onRoundStart?.(ctx) after new level loads
}
```

### Hook Context (ctx)

Shared object passed to all hooks:

```js
const ctx = {
  spawn,           // runtime spawning (same function used in setup)
  gameObjects,     // live Map of all game objects
  broadcast,       // send messages to all clients
  gameState,       // { tick, roundNumber, scores, paused, matchOver }
  activeMode,      // read the mode config
}
```

## Hook Firing Points

### Level hooks

| Hook | Call site | When |
|------|----------|------|
| `onRoundStart(ctx)` | `modeRunner.js` | After level is loaded, before unpausing |
| `onMissileFired(ctx, trebuchet, missile)` | `trebuchet.js` `releaseLoadedMissileFromTrebuchet()` | After missile detaches and gets velocity |
| `onObjectHit(ctx, target, hitBy)` | New collision callback in `physics.js` | When Havok reports a contact (follow-up work) |

### Mode hooks

| Hook | Call site | When |
|------|----------|------|
| `onRoundWon(ctx, winner, loser)` | `modeRunner.js` | After scoring, before transition delay |
| `onMatchWon(ctx, winner)` | `modeRunner.js` | After final round is won |
| `onMatchReset(ctx)` | `modeRunner.js` | After reset input from client |

`onObjectHit` requires wiring up Havok collision observables — designed as a hook signature here, collision detection infrastructure is follow-up work.

## Impact on Existing Code

### Replaced
- `public/assets/levels/level1.json` — replaced by `server/game/levels/level1.js`

### Modified
- `loop.js` — `tryRecordRoundWin()` becomes `modeRunner.checkRoundEnd()`
- `level.js` — replaced by `levelRunner.js`. Arena loading (`loadArenaGlb`) and `clearScene()` move into `levelRunner.js` directly
- `server/index.js` — startup: `import classicMode` then `modeRunner.startMode(classicMode)` instead of `discoverLevels() → firstLevel() → loadLevelIfPresent()`
- `input.js` — `resetMatch()` / `resetGameState()` calls point to `modeRunner`
- `trebuchet.js` — `releaseLoadedMissileFromTrebuchet()` fires `onMissileFired` hook

### Untouched
- `templateRegistry.js` — still discovers and caches templates at startup
- `physics.js` — `createPhysicsBodies()`, collider logic, body sync all stay
- `entities.js` — type checks, wire format, arm states all stay
- `simulation.js` — physics tick stays
- `trebuchet.js` — mechanics stay (only adds hook call)
- `drag.js` — drag mechanics stay
- `state.js` — `gameObjects`, `loadTargets`, `dragState` Maps stay
- All client code — zero changes

### Deleted
- `public/assets/levels/level1.json`
- `server/game/levelCatalog.js`
- `server/game/level.js` — replaced by `levelRunner.js`
- `server/game/rules.js` — replaced by `modeRunner.js`

## Config Migration

These values move from `BARRAGE_CONFIG` (public/config.js) into mode definitions:

| Value | From | To |
|-------|------|----|
| `roundsToWin` | `BARRAGE_CONFIG.roundsToWin` | `mode.roundsToWin` |
| `kingKnockoutAngle` | `BARRAGE_CONFIG.kingKnockoutAngle` | `mode.kingKnockoutAngle` |
| `postWinSimulationMs` | `BARRAGE_CONFIG.postWinSimulationMs` | `mode.postWinDelayMs` |
| `roundEndDelayMs` | `BARRAGE_CONFIG.roundEndDelayMs` | `mode.roundEndDelayMs` |

All other `BARRAGE_CONFIG` values (physics tuning, trebuchet limits, rendering, drag behavior) stay in `config.js` — they're gameplay mechanics, not mode concerns.
