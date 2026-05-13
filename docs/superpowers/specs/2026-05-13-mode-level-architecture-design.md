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

Internally does what `spawnObjectsFromConfig` currently does per-entry: looks up template from registry (warns and skips if not found), builds game object with physics properties, adds to `gameObjects` Map, and populates `loadTargets` for trebuchets. The `spawn` function is created fresh per level load so ID counters reset.

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
  let levelModule;
  try {
    levelModule = await import(`./levels/${levelId}.js`);
  } catch (error) {
    throw new Error(`Failed to load level "${levelId}": ${error.message}`);
  }
  const levelDef = levelModule.default;

  clearScene();

  if (levelDef.arena) {
    await loadArenaGlb(levelDef.arena);
    createArenaColliders();
  }

  const counters = new Map();
  function spawn(templatePath, opts = {}) {
    const count = counters.get(templatePath) ?? 0;
    counters.set(templatePath, count + 1);
    const id = `${templatePath}_${count}`;

    const templateData = getTemplate(templatePath);
    if (!templateData) {
      console.warn(`Template "${templatePath}" not found, skipping ${id}`);
      return;
    }

    // Build game object — same fields as current spawnObjectsFromConfig:
    // position, origin, velocity, bounds, physics props, type-specific fields
    gameObjects.set(id, object);

    // Populate loadTargets for trebuchets (targetNode, rootNode, armNode, offsets)
    if (isTrebuchetName(id) && templateData.targetNode) {
      loadTargets.set(id, { ... });
    }
  }

  levelDef.setup(spawn);
  createPhysicsBodies();

  // Construct URL for client broadcast
  const levelUrl = levelDef.arena ? `/assets/${levelDef.arena}` : null;

  return { def: levelDef, url: levelUrl };
}
```

### modeRunner.js

Replaces `rules.js`. Drives the match lifecycle.

State:
- `activeMode` — the current mode definition
- `activeLevel` — the current level result from levelRunner (`{ def, url }`)
- `levelIndex` — current position in the mode's level list

Public API:
- `startMode(modeDef)` — initializes match state, loads first level
- `checkRoundEnd()` — called each tick (replaces `tryRecordRoundWin()`)
- `resetMatch()` — called on client reset input
- `resetRoundState()` — soft reset within a round (replaces `resetGameState()`)

```js
async function startMode(modeDef) {
  if (!modeDef.levels?.length) {
    throw new Error(`Mode "${modeDef.name}" has no levels defined`);
  }

  activeMode = modeDef;
  levelIndex = 0;
  gameState.roundNumber = 1;
  gameState.scores = {};
  gameState.matchOver = false;
  gameState.paused = false;

  activeLevel = await loadLevel(modeDef.levels[0]);

  // Maintain gameState.currentLevel for connections.js welcome message
  gameState.currentLevel = { url: activeLevel.url };

  await activeLevel.def.hooks?.onRoundStart?.(ctx);
}

function checkRoundEnd() {
  // resolve winCondition — string key or custom function
  // on win: update scores, broadcast roundEnded
  // call activeMode.hooks?.onRoundWon?.(ctx, winner, loser)
  // after delay: load next level or end match
  // update gameState.currentLevel with new level URL
  // await activeLevel.def.hooks?.onRoundStart?.(ctx) after new level loads
  // include level URL in roundStarted / matchReset broadcast messages
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
  activeLevel,     // current level { def, url }
}
```

### Hook Semantics

All hooks are **fire-and-forget**. Return values are ignored.

**Async support:** `onRoundStart`, `onRoundWon`, `onMatchWon`, and `onMatchReset` are awaited — they may perform async setup. `onMissileFired` is called synchronously within the physics tick and must not be async.

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
- `server/index.js` — startup: `import classicMode` then `modeRunner.startMode(classicMode)` instead of `discoverLevels() → firstLevel() → loadLevelIfPresent()`
- `input.js` — `resetMatch()` / `resetGameState()` calls point to `modeRunner`
- `trebuchet.js` — `releaseLoadedMissileFromTrebuchet()` fires `onMissileFired` hook
- `connections.js` — welcome message reads `gameState.currentLevel?.url` (no change needed — modeRunner maintains this field)
- `public/config.js` — remove `roundsToWin`, `kingKnockoutAngle`, `postWinSimulationMs`, `roundEndDelayMs` (migrated to mode)

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

These four keys are **removed** from `BARRAGE_CONFIG` after migration to avoid a dual source of truth. All other `BARRAGE_CONFIG` values (physics tuning, trebuchet limits, rendering, drag behavior) stay in `config.js` — they're gameplay mechanics, not mode concerns.

## Notes

**Dynamic import caching.** Node caches ESM modules after first `import()`. Level definitions are static objects so this is fine — `setup()` runs fresh each time. But editing a level file won't take effect without a server restart. Acceptable for now; a dev-mode file watcher could be added later if level iteration speed matters.

**Client message contract.** The client depends on level URLs in `welcome`, `roundStarted`, and `matchReset` messages. The modeRunner must include `level: activeLevel.url` in these broadcast payloads. As long as message shapes are preserved, all client code remains untouched.

**levelOrder: "random"** — uses shuffle-without-repeat: all levels are played once in random order before any repeats. `pickNextLevel()` in modeRunner maintains a shuffled queue, refilled when exhausted.

**Custom winCondition performance.** `checkRoundEnd()` runs every tick (60/s). Custom win condition functions must be cheap — no allocations per call, no large iterations. The built-in `"kingKnockout"` iterates only king objects (typically 2). Custom functions should follow the same pattern.

**Mode switching at runtime** is not in scope. `startMode()` is called once at startup. Supporting mid-game mode switching would require client notification and UI for mode selection — future work.

**resetRoundState()** must faithfully port the full property reset from current `resetGameState()` (rules.js:15-52): position to origin, zero velocities, clear drag state, reset trebuchet arm/aim/fire state, reset missile loadedInto, reset king hits, and call `syncPhysicsBodyFromObject` per object. This is ~20 properties per object — the logic moves as-is, not reimplemented.
