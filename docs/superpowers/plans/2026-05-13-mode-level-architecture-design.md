# Mode + Level Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace JSON-based level config and hardcoded round/match flow with JS module-based modes and levels.

**Architecture:** Game modes (match flow, scoring, level rotation) and levels (spawning, per-map hooks) become separate JS modules. `modeRunner.js` drives the match lifecycle, `levelRunner.js` loads and runs levels. Current `rules.js`, `level.js`, `levelCatalog.js`, and `level1.json` are replaced.

**Tech Stack:** Node.js ES modules, dynamic `import()`, Babylon.js NullEngine + Havok physics (server-side)

**Spec:** `docs/superpowers/specs/2026-05-13-mode-level-architecture-design.md`

---

### Task 1: Create level definition

**Files:**
- Create: `server/game/levels/level1.js`

- [ ] **Step 1: Create the level1.js file**

Convert the current `public/assets/levels/level1.json` to a JS module with `setup(spawn)`:

```js
// server/game/levels/level1.js
export default {
  arena: "levels/level1.glb",

  setup(spawn) {
    spawn("trebuchets/basic", { x: -25, y: 1, player: 1 });
    spawn("trebuchets/basic", { x: 25, y: 1, player: 2 });

    spawn("kings/default-L", { x: -37, y: 1.05, player: 1 });
    spawn("kings/default-R", { x: 37, y: 1.05, player: 2 });

    spawn("blocks/defarult-L", { x: -12, y: 1 });
    spawn("blocks/defarult-L", { x: -12, y: 9, rotation: 45 });
    spawn("blocks/fragmented-L", { x: 12, y: 1 });
    spawn("blocks/fragmented-R", { x: 12, y: 9, rotation: -45 });

    spawn("missiles/basic", { x: 0, y: 0.5 });
    spawn("missiles/basic", { x: 0, y: 6 });
  },

  hooks: {},
};
```

Note: `defarult` is intentional — matches the actual GLB filenames in `public/assets/templates/blocks/`. All `z` values default to `0` via the spawn function.

---

### Task 2: Create mode definition

**Files:**
- Create: `server/game/modes/classic.js`

- [ ] **Step 1: Create the classic.js file**

Extract round/match config values from `public/config.js` into the mode definition:

```js
// server/game/modes/classic.js
export default {
  name: "classic",
  levels: ["level1"],
  roundsToWin: 3,
  winCondition: "kingKnockout",
  kingKnockoutAngle: 45,
  postWinDelayMs: 2000,
  roundEndDelayMs: 2000,
  levelOrder: "sequential",
  hooks: {},
};
```

- [ ] **Step 2: Commit**

```bash
git add server/game/levels/level1.js server/game/modes/classic.js
git commit -m "feat: add level1 and classic mode definitions"
```

---

### Task 3: Create levelRunner

**Files:**
- Create: `server/game/levelRunner.js`

Replaces `server/game/level.js`. Moves `clearScene()`, `spawnObjectsFromConfig()`, and `loadLevelIfPresent()` into a single `loadLevel(levelId)` function that uses dynamic imports instead of JSON config.

- [ ] **Step 1: Write levelRunner.js**

```js
// server/game/levelRunner.js
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import xhr2 from "xhr2";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader.js";
import "@babylonjs/loaders/glTF/index.js";
import { scene, physicsAggregates, createPhysicsBodies, createArenaColliders } from "./physics.js";
import { gameObjects, loadTargets, dragState } from "./state.js";
import { PORT } from "../config.js";
import { SERVER_CONFIG } from "../config.js";
import {
  isTrebuchetName,
  isMissileName,
  isKingName,
  restArmAngleForTrebuchet,
  ARM_STATE_IDLE,
} from "./entities.js";
import { getTemplate } from "./templateRegistry.js";

const { XMLHttpRequest } = xhr2;
globalThis.XMLHttpRequest = XMLHttpRequest;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.join(__dirname, "../../public/assets");

function clearScene() {
  for (const [, aggregate] of physicsAggregates) {
    aggregate.dispose();
  }
  physicsAggregates.clear();
  gameObjects.clear();
  loadTargets.clear();
  dragState.clear();

  const arenaRoots = scene.rootNodes.filter((n) => n.name === "__root__");
  for (const root of arenaRoots) {
    root.dispose(false, true);
  }
}

function createSpawnFunction() {
  const counters = new Map();

  return function spawn(templatePath, opts = {}) {
    const count = counters.get(templatePath) ?? 0;
    counters.set(templatePath, count + 1);
    const id = `${templatePath}_${count}`;

    const templateData = getTemplate(templatePath);
    if (!templateData) {
      console.warn(`Template "${templatePath}" not found in registry, skipping ${id}`);
      return;
    }

    const bounds = templateData.bounds;

    const object = {
      id,
      x: opts.x ?? 0,
      y: opts.y ?? 0,
      z: opts.z ?? 0,
      originX: opts.x ?? 0,
      originY: opts.y ?? 0,
      originZ: opts.z ?? 0,
      rot: opts.rotation ?? 0,
      originRot: opts.rotation ?? 0,
      angularVelocity: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      dragVx: 0,
      dragVy: 0,
      dragVz: 0,
      dynamic: true,
      draggedBy: null,
      offsetX: bounds.offsetX,
      offsetY: bounds.offsetY,
      offsetZ: bounds.offsetZ,
      halfX: bounds.halfX,
      halfY: bounds.halfY,
      halfZ: bounds.halfZ,
      halfHeight: bounds.halfY,
      mass: SERVER_CONFIG.dynamicMass,
      friction: SERVER_CONFIG.dynamicFriction,
      restitution: SERVER_CONFIG.dynamicRestitution,
      player: opts.player ?? null,
      ...(isTrebuchetName(id) ? {
        loaded: false,
        loadedMissileId: null,
        fireState: ARM_STATE_IDLE,
        armAngle: restArmAngleForTrebuchet(),
        aimedBy: null,
        aimStart: null,
        aimCurrent: null,
        pendingShot: null,
        returnStartArmAngle: null,
        releaseElapsedMs: 0,
      } : {}),
      ...(isMissileName(id) ? { loadedInto: null } : {}),
      ...(isKingName(id) ? { hits: 0, maxHits: 3 } : {}),
    };

    gameObjects.set(id, object);

    if (isTrebuchetName(id) && templateData.targetNode) {
      loadTargets.set(id, {
        targetNode: templateData.targetNode,
        rootNode: templateData.rootNode,
        armNode: templateData.armNode,
        offsetX: templateData.loadTargetOffsetX,
        offsetY: templateData.loadTargetOffsetY,
        offsetZ: templateData.loadTargetOffsetZ,
      });
    }
  };
}

export async function loadLevel(levelId) {
  let levelModule;
  try {
    levelModule = await import(`./levels/${levelId}.js`);
  } catch (error) {
    throw new Error(`Failed to load level "${levelId}": ${error.message}`);
  }
  const levelDef = levelModule.default;

  clearScene();

  if (levelDef.arena) {
    const fullPath = path.join(assetsDir, levelDef.arena);
    try {
      await fs.access(fullPath);
      await SceneLoader.AppendAsync(`http://localhost:${PORT}/assets/`, levelDef.arena, scene);
      console.log(`Loaded arena: ${levelDef.arena}`);
    } catch {
      console.log(`No arena GLB at public/assets/${levelDef.arena}; starting with empty scene.`);
    }
  }

  createArenaColliders();

  const spawn = createSpawnFunction();
  levelDef.setup(spawn);
  createPhysicsBodies();

  const levelUrl = levelDef.arena ? `/assets/${levelDef.arena}` : null;

  for (const object of gameObjects.values()) {
    console.log(
      `  ${object.id}: pos=(${object.x.toFixed(2)}, ${object.y.toFixed(2)}, ${object.z.toFixed(2)}) half=(${object.halfX.toFixed(2)}, ${object.halfY.toFixed(2)}, ${object.halfZ.toFixed(2)}) player=${object.player}`,
    );
  }

  return { def: levelDef, url: levelUrl, spawn };
}
```

Key differences from the old `level.js`:
- `clearScene()` is identical (moved as-is from `level.js:26-39`).
- `createSpawnFunction()` returns a closure with per-level ID counters. Object construction matches `spawnObjectsFromConfig()` exactly — same fields, same type-specific spreads.
- `loadLevel()` replaces both `loadLevelIfPresent()` and `reloadLevel()`. Uses dynamic `import()` for level modules instead of reading JSON. Always calls `createArenaColliders()` (ensures fallback ground plane even without arena GLB).

- [ ] **Step 2: Commit**

```bash
git add server/game/levelRunner.js
git commit -m "feat: add levelRunner for level loading and spawning"
```

---

### Task 4: Create modeRunner

**Files:**
- Create: `server/game/modeRunner.js`

Replaces `server/game/rules.js`. Drives match lifecycle: start mode, check round end, reset match, reset round state.

- [ ] **Step 1: Write modeRunner.js**

```js
// server/game/modeRunner.js
import {
  isKingName,
  restArmAngleForTrebuchet,
  ARM_STATE_IDLE,
} from "./entities.js";
import { gameObjects, gameState, dragState } from "./state.js";
import { broadcast } from "../net/broadcast.js";
import { syncPhysicsBodyFromObject, setPhysicsBodyTrigger } from "./physics.js";
import { loadLevel } from "./levelRunner.js";

let activeMode = null;
let activeLevel = null;
let levelIndex = 0;
let roundEndInProgress = false;
let shuffledQueue = [];

export function getActiveLevel() {
  return activeLevel;
}

export function getHookContext() {
  return {
    spawn: activeLevel?.spawn ?? (() => {}),
    gameObjects,
    broadcast,
    gameState,
    activeMode,
    activeLevel,
  };
}

export async function callHook(fn, ...args) {
  if (!fn) return;
  try {
    await fn(...args);
  } catch (error) {
    console.error("Hook error:", error);
  }
}

export function resetRoundState() {
  dragState.clear();

  for (const object of gameObjects.values()) {
    object.x = object.originX;
    object.y = object.originY;
    object.z = object.originZ;
    object.rot = object.originRot ?? 0;
    object.angularVelocity = 0;
    object.vx = 0;
    object.vy = 0;
    object.vz = 0;
    object.dragVx = 0;
    object.dragVy = 0;
    object.dragVz = 0;
    object.draggedBy = null;

    if (object.loaded !== undefined) object.loaded = false;
    if (object.loadedInto !== undefined) {
      object.loadedInto = null;
      setPhysicsBodyTrigger(object, false);
    }
    if (object.armAngle !== undefined) object.armAngle = restArmAngleForTrebuchet();
    if (object.fireState !== undefined) object.fireState = ARM_STATE_IDLE;
    if (object.loadedMissileId !== undefined) object.loadedMissileId = null;
    if (object.aimedBy !== undefined) object.aimedBy = null;
    if (object.aimStart !== undefined) object.aimStart = null;
    if (object.aimCurrent !== undefined) object.aimCurrent = null;
    if (object.pendingShot !== undefined) object.pendingShot = null;
    if (object.returnStartArmAngle !== undefined) object.returnStartArmAngle = null;
    if (object.releaseElapsedMs !== undefined) object.releaseElapsedMs = 0;

    if (object.hits !== undefined) {
      object.hits = 0;
    }

    syncPhysicsBodyFromObject(object, { x: 0, y: 0, z: 0 });
  }
}

function checkKingKnockout() {
  const threshold = activeMode?.kingKnockoutAngle ?? 45;
  for (const object of gameObjects.values()) {
    if (!isKingName(object.id)) continue;
    if (Math.abs(object.rot) < threshold) continue;
    const loserId = object.player === 1 ? "P1" : "P2";
    return { winner: loserId === "P1" ? "P2" : "P1", loser: loserId };
  }
  return null;
}

function evaluateWinCondition() {
  const wc = activeMode?.winCondition ?? "kingKnockout";
  if (typeof wc === "function") return wc(getHookContext());
  if (wc === "kingKnockout") return checkKingKnockout();
  return null;
}

function pickNextLevel() {
  if (activeMode.levelOrder === "random") {
    if (shuffledQueue.length === 0) {
      shuffledQueue = [...activeMode.levels];
      for (let i = shuffledQueue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffledQueue[i], shuffledQueue[j]] = [shuffledQueue[j], shuffledQueue[i]];
      }
    }
    return shuffledQueue.shift();
  }

  levelIndex = (levelIndex + 1) % activeMode.levels.length;
  return activeMode.levels[levelIndex];
}

export async function startMode(modeDef) {
  if (!modeDef.levels?.length) {
    throw new Error(`Mode "${modeDef.name}" has no levels defined`);
  }

  activeMode = modeDef;
  levelIndex = 0;
  shuffledQueue = [];
  roundEndInProgress = false;
  gameState.roundNumber = 1;
  gameState.scores = {};
  gameState.matchOver = false;
  gameState.paused = false;

  activeLevel = await loadLevel(modeDef.levels[0]);
  gameState.currentLevel = { url: activeLevel.url };

  await callHook(activeLevel.def.hooks?.onRoundStart, getHookContext());
}

export function checkRoundEnd() {
  if (roundEndInProgress || gameState.matchOver) return;

  const result = evaluateWinCondition();
  if (!result) return;

  roundEndInProgress = true;
  const { winner, loser } = result;

  gameState.scores[winner] = (gameState.scores[winner] ?? 0) + 1;

  const roundsToWin = activeMode?.roundsToWin ?? 3;
  const isMatchWon = gameState.scores[winner] >= roundsToWin;

  broadcast({
    type: "roundEnded",
    winner,
    loser,
    roundNumber: gameState.roundNumber,
    scores: gameState.scores,
  });

  const postSimMs = activeMode?.postWinDelayMs ?? 2000;

  if (isMatchWon) {
    setTimeout(async () => {
      await callHook(activeMode?.hooks?.onRoundWon, getHookContext(), winner, loser);
      gameState.paused = true;
      gameState.matchOver = true;
      roundEndInProgress = false;
      await callHook(activeMode?.hooks?.onMatchWon, getHookContext(), winner);
      broadcast({
        type: "matchEnded",
        winner,
        scores: gameState.scores,
      });
    }, postSimMs);
    return;
  }

  const resetDelayMs = activeMode?.roundEndDelayMs ?? 2000;

  setTimeout(async () => {
    await callHook(activeMode?.hooks?.onRoundWon, getHookContext(), winner, loser);
    gameState.paused = true;
  }, postSimMs);

  setTimeout(async () => {
    gameState.roundNumber += 1;
    const nextLevelId = pickNextLevel();
    try {
      activeLevel = await loadLevel(nextLevelId);
    } catch (error) {
      console.error(`Failed to load next level "${nextLevelId}":`, error.message);
      roundEndInProgress = false;
      gameState.paused = false;
      return;
    }
    gameState.currentLevel = { url: activeLevel.url };
    gameState.paused = false;
    roundEndInProgress = false;
    await callHook(activeLevel.def.hooks?.onRoundStart, getHookContext());
    broadcast({
      type: "roundStarted",
      roundNumber: gameState.roundNumber,
      scores: gameState.scores,
      level: activeLevel.url,
    });
  }, resetDelayMs);
}

export async function resetMatch() {
  levelIndex = 0;
  shuffledQueue = [];
  try {
    activeLevel = await loadLevel(activeMode.levels[0]);
  } catch (error) {
    console.error(`Failed to load level "${activeMode.levels[0]}" on match reset:`, error.message);
    gameState.paused = false;
    roundEndInProgress = false;
    return;
  }
  gameState.currentLevel = { url: activeLevel.url };
  gameState.roundNumber = 1;
  gameState.scores = {};
  gameState.paused = false;
  gameState.matchOver = false;
  roundEndInProgress = false;
  await callHook(activeMode?.hooks?.onMatchReset, getHookContext());
  broadcast({
    type: "matchReset",
    roundNumber: gameState.roundNumber,
    scores: gameState.scores,
    level: activeLevel.url,
  });
}
```

Key design decisions:
- `resetRoundState()` is an exact copy of `rules.js:resetGameState()` (lines 15-52) — same 20 properties reset per object, same order. This is intentional per spec.
- `checkKingKnockout()` returns `{ winner, loser }` (not the knocked king object), matching what `evaluateWinCondition` callers expect.
- `checkRoundEnd()` is synchronous (called from game loop tick). All async hooks (`onRoundWon`, `onMatchWon`, `onRoundStart`) are awaited inside `setTimeout` async callbacks — never in the synchronous tick path. `onRoundWon` fires after the post-win simulation delay (inside the `postSimMs` setTimeout), before the pause/transition logic. This shifts timing slightly from the spec's "immediately after scoring" but ensures proper async support.
- `pickNextLevel()` uses Fisher-Yates shuffle-without-repeat for `"random"` order.
- `getHookContext()` builds a fresh ctx object each call, including the `spawn` function from the current level load.

- [ ] **Step 2: Commit**

```bash
git add server/game/modeRunner.js
git commit -m "feat: add modeRunner for match lifecycle"
```

---

### Task 5: Wire loop.js to modeRunner

**Files:**
- Modify: `server/game/loop.js:4,14`

- [ ] **Step 1: Replace tryRecordRoundWin import with checkRoundEnd**

Change the import on line 4:

```js
// Before:
import { tryRecordRoundWin } from "./rules.js";

// After:
import { checkRoundEnd } from "./modeRunner.js";
```

- [ ] **Step 2: Replace the function call on line 14**

```js
// Before:
    tryRecordRoundWin();

// After:
    checkRoundEnd();
```

---

### Task 6: Wire input.js to modeRunner

**Files:**
- Modify: `server/game/input.js:2,19`

- [ ] **Step 1: Replace rules.js import with modeRunner imports**

Change line 2:

```js
// Before:
import { resetMatch, resetGameState } from "./rules.js";

// After:
import { resetMatch, resetRoundState } from "./modeRunner.js";
```

- [ ] **Step 2: Replace resetGameState call with resetRoundState**

Change line 19:

```js
// Before:
      resetGameState();

// After:
      resetRoundState();
```

---

### Task 7: Add onMissileFired hook to trebuchet.js

**Files:**
- Modify: `server/game/trebuchet.js:1-2,225`

- [ ] **Step 1: Add modeRunner imports**

Add after the existing imports (after line 14):

```js
import { getActiveLevel, getHookContext, callHook } from "./modeRunner.js";
```

No circular dependency: `modeRunner.js` → `levelRunner.js` → `physics.js`, `entities.js`, etc. `trebuchet.js` → `modeRunner.js` is a new edge, and `modeRunner.js` does NOT import from `trebuchet.js`.

- [ ] **Step 2: Call the hook in releaseLoadedMissileFromTrebuchet**

In `releaseLoadedMissileFromTrebuchet()`, add the hook call just before `return true` (after line 227):

```js
  trebuchet.aimStart = null;
  trebuchet.aimCurrent = null;

  callHook(getActiveLevel()?.def?.hooks?.onMissileFired, getHookContext(), trebuchet, missile);

  return true;
```

`callHook` is not awaited here — `releaseLoadedMissileFromTrebuchet` runs in the synchronous physics tick. The `callHook` wrapper catches both sync throws and async rejections internally, so a buggy hook cannot crash the game loop.

---

### Task 8: Wire server/index.js

**Files:**
- Modify: `server/index.js:7-10,117-120`

- [ ] **Step 1: Update imports**

Replace lines 7-10:

```js
// Before:
import { clients, gameState } from "./game/state.js";
import { enableHavokPhysics } from "./game/physics.js";
import { loadLevelIfPresent } from "./game/level.js";
import { discoverLevels, firstLevel } from "./game/levelCatalog.js";

// After:
import { clients } from "./game/state.js";
import { enableHavokPhysics } from "./game/physics.js";
import { startMode } from "./game/modeRunner.js";
import classicMode from "./game/modes/classic.js";
```

`gameState` is removed from the import — it was only used for the startup sequence which `startMode` now handles internally.

- [ ] **Step 2: Update startup sequence**

Replace lines 117-120:

```js
// Before:
await discoverLevels();
gameState.currentLevel = firstLevel();
await loadLevelIfPresent(gameState.currentLevel);

// After:
await startMode(classicMode);
```

`startMode` handles: loading the first level, setting `gameState.currentLevel`, calling the level's `onRoundStart` hook.

---

### Task 9: Remove migrated config keys and delete old files

**Files:**
- Modify: `public/config.js:46-50`
- Delete: `server/game/level.js`
- Delete: `server/game/levelCatalog.js`
- Delete: `server/game/rules.js`
- Delete: `public/assets/levels/level1.json`

- [ ] **Step 1: Verify no remaining references to the migrated config keys**

Run:

```bash
grep -rn "kingKnockoutAngle\|roundsToWin\|postWinSimulationMs\|roundEndDelayMs" --include="*.js" server/ public/client/
```

Expected: zero results (these keys are now read from `activeMode` in `modeRunner.js`, not from `BARRAGE_CONFIG`).

- [ ] **Step 2: Remove migrated keys from public/config.js**

Remove lines 46-50 (the "Zone rules" comment and four config values):

```js
// Remove this block:
  // Zone rules.
  kingKnockoutAngle: 45,
  roundsToWin: 3,
  postWinSimulationMs: 2000,
  roundEndDelayMs: 2000,
```

- [ ] **Step 3: Verify no remaining imports of the old files**

Run:

```bash
grep -rn "from.*\./level\.\|from.*levelCatalog\|from.*\./rules\.\|level1\.json" --include="*.js" server/ public/
```

Expected: zero results (all imports now point to `modeRunner.js` and `levelRunner.js`).

- [ ] **Step 4: Delete old files**

```bash
git rm server/game/level.js
git rm server/game/levelCatalog.js
git rm server/game/rules.js
git rm public/assets/levels/level1.json
```

- [ ] **Step 5: Commit the switchover**

This commit covers Tasks 5-9 — all wiring changes, config cleanup, and file deletions:

```bash
git add server/game/loop.js server/game/input.js server/game/trebuchet.js server/index.js public/config.js
git commit -m "refactor: switch to mode/level architecture

Replace rules.js, level.js, and levelCatalog.js with modeRunner.js
and levelRunner.js. Level configs move from JSON to JS modules.
Round/match config moves from BARRAGE_CONFIG to mode definitions."
```

---

### Task 10: Smoke test

- [ ] **Step 1: Start the dev server**

```bash
npm run dev
```

Expected console output (in order):
1. `Barrage server running at http://localhost:3000`
2. Template loading messages (`Template "trebuchets/basic": half=...`)
3. Arena loading: `Loaded arena: levels/level1.glb`
4. Arena collider messages or `No arena colliders found — creating fallback ground body.`
5. Object spawn log — 10 objects matching the level1.js definition:
   - `trebuchets/basic_0`, `trebuchets/basic_1`
   - `kings/default-L_0`, `kings/default-R_0`
   - `blocks/defarult-L_0`, `blocks/defarult-L_1`
   - `blocks/fragmented-L_0`, `blocks/fragmented-R_0`
   - `missiles/basic_0`, `missiles/basic_1`

No errors in console.

- [ ] **Step 2: Verify in browser**

Open two tabs at `http://localhost:3000`.

Verify:
- Tab 1 shows "P1", Tab 2 shows "P2"
- All objects visible and in correct positions
- Trebuchets draggable on X axis
- Missiles load into trebuchets when dragged near
- Aiming and firing work
- King knockout triggers round end
- Reset button resets objects to origin
- After 3 rounds, match ends; reset starts new match
