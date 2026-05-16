# Config Separation & Level Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate client-only config from server gameplay config, eliminate the mixed `BARRAGE_CONFIG` global, add per-level config overrides, and make the collision system config-driven.

**Architecture:** `public/config.js` (mixed concerns) gets deleted. Client-only values move to `public/client/clientConfig.js`. Gameplay values move to `server/config.js` with a `getConfig(key)` resolution layer that checks level overrides first. Server sends relevant config to clients in `welcome`/`roundStarted`/`matchReset` messages.

**Tech Stack:** Vanilla JS (ES modules), Babylon.js, Node.js, WebSocket

**Spec:** `docs/superpowers/specs/2026-05-15-config-separation-level-config-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `server/config.js` | Modify | Expanded `SERVER_CONFIG`, `getConfig()`, `setActiveLevelConfig()`, `getClientRelevantConfig()` |
| `public/client/clientConfig.js` | Create | Client-only rendering, input, aim arrow visual config |
| `server/game/entities.js` | Modify | Replace `BARRAGE_CONFIG` reads with `getConfig()` |
| `server/game/trebuchet.js` | Modify | Replace `BARRAGE_CONFIG` reads with `getConfig()`, remove dead `aimArmMaxExtraDegrees` ref |
| `server/game/simulation.js` | Modify | Replace `BARRAGE_CONFIG` reads with `getConfig()` |
| `server/game/physics.js` | Modify | Replace `BARRAGE_CONFIG` reads with `getConfig()` |
| `server/game/templateRegistry.js` | Modify | Replace `BARRAGE_CONFIG` reads with `getConfig()` |
| `server/game/fragmentation.js` | Modify | Replace `BARRAGE_CONFIG` reads with `getConfig()`, export `deleteBlock` |
| `server/game/collisions.js` | Modify | Config-driven crack/fragmentation logic via `getConfig()` |
| `server/game/levels/level1.js` | Modify | Add `config` block, remove `onBlockDestroyed` hook |
| `server/game/levelRunner.js` | Modify | Call `setActiveLevelConfig()` inside `loadLevel()` |
| `server/game/modeRunner.js` | Modify | Include config in `roundStarted` and `matchReset` broadcasts |
| `server/net/connections.js` | Modify | Include config in `welcome` message |
| `public/client/engine.js` | Modify | Import `CLIENT_CONFIG` instead of `BARRAGE_CONFIG` |
| `public/client/network.js` | Modify | Add `serverConfig` state and `getServerConfig()` export |
| `public/client/aim.js` | Modify | Use `CLIENT_CONFIG` for arrow visuals, `getServerConfig()` for shared values |
| `public/client/input.js` | Modify | Use `CLIENT_CONFIG` for input settings, `getServerConfig()` for shared values |
| `public/client/level.js` | Modify | Use `CLIENT_CONFIG` for rendering, `getServerConfig()` for `fragmentShrinkMs` |
| `public/config.js` | Delete | Removes `BARRAGE_CONFIG` and `window.BARRAGE_CONFIG` global |

---

### Task 1: Expand server/config.js — Config Foundation

**Files:**
- Modify: `server/config.js`

This task creates the foundation everything else depends on: the expanded `SERVER_CONFIG`, the `getConfig()` resolution layer, `setActiveLevelConfig()`, and `getClientRelevantConfig()`.

- [ ] **Step 1: Replace the contents of `server/config.js`**

Replace the entire file with the expanded config. Keep `PORT`, `TICK_RATE`, `TICK_MS` unchanged at the top. Add all gameplay values from `BARRAGE_CONFIG` into `SERVER_CONFIG`. Add the level config resolution functions. Note: `physicsEnabled` from `BARRAGE_CONFIG` is intentionally dropped — it was defined but never read anywhere in the codebase (dead code).

```js
export const PORT = Number(process.env.PORT || 3000);
export const TICK_RATE = 60;
export const TICK_MS = 1000 / TICK_RATE;

export const SERVER_CONFIG = {
  // Engine
  gravity: -9.81,
  groundY: 0,
  physicsTimeScale: 1.5,

  // World bounds
  worldMinX: -70,
  worldMaxX: 70,
  worldMinZ: -20,
  worldMaxZ: 20,

  // Physics defaults
  dynamicMass: 6,
  dynamicFriction: 0.9,
  dynamicRestitution: 0.15,
  blockMass: 20,
  blockFriction: 0.9,
  blockRestitution: 0.15,
  staticFriction: 1.0,

  // Trebuchet mechanics
  trebuchetArmRestRotationZDegrees: 15,
  trebuchetLeftMinX: -30,
  trebuchetLeftMaxX: -5,
  trebuchetRightMinX: 5,
  trebuchetRightMaxX: 30,
  missileLoadRange: 2,
  aimMaxPullDistance: 4.5,
  aimPowerScale: 8,
  trebuchetArmPullbackMaxDegrees: 75,
  trebuchetFireVelocityMax: 33,
  fireReleaseAnimationMs: 180,
  fireReturnAnimationMs: 220,
  normalReleaseVelocityMax: 8,
  releaseVelocityMax: 80,
  dragUprightLerp: 0.25,

  // Fragments
  fragmentLifetimeMs: 5000,
  fragmentSpreadX: 4,
  fragmentSpreadY: 2,
  fragmentShrinkMs: 500,
  fragmentImmunityMs: 500,
  fragmentHitSpeedPenalty: 3,

  // Features (level-overridable)
  crackSystem: true,
  fragmentation: true,
};

let activeLevelConfig = null;

export function setActiveLevelConfig(config) {
  activeLevelConfig = config ?? null;
}

export function getConfig(key) {
  return activeLevelConfig?.[key] ?? SERVER_CONFIG[key];
}

const CLIENT_RELEVANT_KEYS = [
  "trebuchetArmRestRotationZDegrees",
  "normalReleaseVelocityMax",
  "aimMaxPullDistance",
  "fragmentShrinkMs",
];

export function getClientRelevantConfig() {
  const result = {};
  for (const key of CLIENT_RELEVANT_KEYS) {
    result[key] = getConfig(key);
  }
  return result;
}
```

- [ ] **Step 2: Verify server starts**

Run: `node server/index.js`
Expected: Server starts on port 3000 without errors. Ctrl+C to stop.

- [ ] **Step 3: Commit**

```bash
git add server/config.js
git commit -m "feat: expand SERVER_CONFIG with gameplay values, add getConfig resolution layer"
```

---

### Task 2: Create Client Config

**Files:**
- Create: `public/client/clientConfig.js`

- [ ] **Step 1: Create `public/client/clientConfig.js`**

```js
export const CLIENT_CONFIG = {
  // Rendering
  importedLightIntensityScale: 0.01,
  fallbackLightIntensity: 0.1,
  shadowsEnabled: true,
  shadowMapSize: 2048,
  shadowBias: 0.0005,
  shadowNormalBias: 0.02,
  exposure: 1.0,
  contrast: 1.0,

  // Input
  inputInvertX: false,
  trebuchetInputInvertX: false,
  inputInvertY: false,
  inputInvertZ: false,
  cameraControlsEnabled: false,

  // Drag/release (client-side feel)
  dragHeightOffset: 0.2,
  releaseVelocityScale: 1.0,
  releaseVelocitySampleHz: 60,
  releaseVelocityFrameWindow: 5,
  releaseVelocityMinSampleDistance: 0.05,
  missilePickColliderScale: 2,

  // Aim arrow visuals
  aimArrowStartColor: "#ffffff",
  aimArrowEndColor: "#39ff14",
  aimArrowMaxLength: 4.5,
  aimArrowRadius: 0.06,
  aimArrowZOffset: 0.05,
  aimArrowMinLength: 0.12,
  aimArrowHeadLengthMin: 0.2,
  aimArrowHeadLengthMax: 0.75,
  aimArrowHeadLengthScale: 0.18,
  aimArrowHeadWidth: 0.12,
  aimArrowHeadWidthScale: 0.45,
};
```

- [ ] **Step 2: Commit**

```bash
git add public/client/clientConfig.js
git commit -m "feat: create clientConfig.js with client-only rendering/input/aim values"
```

---

### Task 3: Migrate Server Gameplay Files — entities.js, trebuchet.js, simulation.js

**Files:**
- Modify: `server/game/entities.js`
- Modify: `server/game/trebuchet.js`
- Modify: `server/game/simulation.js`

- [ ] **Step 1: Migrate `server/game/entities.js`**

Remove the `BARRAGE_CONFIG` and `SERVER_CONFIG` imports. Add `getConfig` import. Replace all config reads with `getConfig("x")` — this keeps the code uniform and allows future level overrides for any value.

Replace the import block at the top (lines 1-3):

```js
import { getConfig } from "../config.js";
import { clamp, clampVector } from "../math.js";
```

Replace `restArmAngleForTrebuchet` (line 51-53):

```js
export function restArmAngleForTrebuchet() {
  return getConfig("trebuchetArmRestRotationZDegrees");
}
```

Replace `normalReleaseVelocityMax` (lines 55-59). The old code had a 3-key fallback chain (`BARRAGE_CONFIG.normalReleaseVelocityMax ?? BARRAGE_CONFIG.releaseVelocityMax ?? SERVER_CONFIG.releaseVelocityMax`). This simplifies to a single key because `SERVER_CONFIG` now always defines `normalReleaseVelocityMax`:

```js
export function normalReleaseVelocityMax() {
  return getConfig("normalReleaseVelocityMax");
}
```

Replace `trebuchetFireVelocityMax` (lines 61-64). Same pattern — old code fell back from `trebuchetFireVelocityMax` to `releaseVelocityMax`. Now a single key since `SERVER_CONFIG` defines it directly:

```js
export function trebuchetFireVelocityMax() {
  return getConfig("trebuchetFireVelocityMax");
}
```

Replace `constrainWorldBounds` (lines 80-94). Use `getConfig()` for all config reads — it falls through to `SERVER_CONFIG` anyway, and keeps the code uniform:

```js
export function constrainWorldBounds(object) {
  object.x = clamp(object.x, getConfig("worldMinX"), getConfig("worldMaxX"));
  object.z = clamp(object.z, getConfig("worldMinZ"), getConfig("worldMaxZ"));

  const floorY = getConfig("groundY") + object.halfY - (object.offsetY ?? 0);
  if (object.y < floorY) {
    object.y = floorY;
    if (object.vy < 0) object.vy = 0;
  }

  if (object.x === getConfig("worldMinX") && object.vx < 0) object.vx = 0;
  if (object.x === getConfig("worldMaxX") && object.vx > 0) object.vx = 0;
  if (object.z === getConfig("worldMinZ") && object.vz < 0) object.vz = 0;
  if (object.z === getConfig("worldMaxZ") && object.vz > 0) object.vz = 0;
}
```

Replace `constrainedPointForObject` trebuchet bounds (lines 108-113):

```js
  const minX = object.player === 1
    ? getConfig("trebuchetLeftMinX")
    : getConfig("trebuchetRightMinX");
  const maxX = object.player === 1
    ? getConfig("trebuchetLeftMaxX")
    : getConfig("trebuchetRightMaxX");
```

- [ ] **Step 2: Migrate `server/game/trebuchet.js`**

Remove the `BARRAGE_CONFIG` import (line 2). Add `getConfig` import.

Replace line 2:

```js
import { getConfig } from "../config.js";
```

Replace all `BARRAGE_CONFIG.x` reads with `getConfig("x")`. The specific replacements:

Line 22: `BARRAGE_CONFIG.fireReturnAnimationMs ?? 220` → `getConfig("fireReturnAnimationMs")`
Line 41: `BARRAGE_CONFIG.fireReleaseAnimationMs ?? 180` → `getConfig("fireReleaseAnimationMs")`
Line 115: `BARRAGE_CONFIG.missileLoadRange ?? 6` → `getConfig("missileLoadRange")`
Line 153: `BARRAGE_CONFIG.aimMaxPullDistance ?? 6` → `getConfig("aimMaxPullDistance")`

Lines 164-167: Remove the dead `aimArmMaxExtraDegrees` reference. Replace:
```js
  const maxExtra = BARRAGE_CONFIG.trebuchetArmPullbackMaxDegrees
    ?? BARRAGE_CONFIG.aimArmMaxExtraDegrees
    ?? 45;
  const restAngle = Math.abs(BARRAGE_CONFIG.trebuchetArmRestRotationZDegrees ?? 15);
```
With:
```js
  const maxExtra = getConfig("trebuchetArmPullbackMaxDegrees");
  const restAngle = Math.abs(getConfig("trebuchetArmRestRotationZDegrees"));
```

Line 177: `BARRAGE_CONFIG.aimPowerScale ?? 8` → `getConfig("aimPowerScale")`
Line 189: `BARRAGE_CONFIG.trebuchetArmRestRotationZDegrees ?? 15` → `getConfig("trebuchetArmRestRotationZDegrees")`

- [ ] **Step 3: Migrate `server/game/simulation.js`**

Remove the `BARRAGE_CONFIG` import (line 12). Replace `SERVER_CONFIG` import to also include `getConfig`.

Replace lines 11-12:

```js
import { SERVER_CONFIG, TICK_MS, getConfig } from "../config.js";
```

Line 18: `BARRAGE_CONFIG.physicsTimeScale ?? 1` → `getConfig("physicsTimeScale")`

Line 77: `SERVER_CONFIG.groundY` stays as-is (or use `getConfig("groundY")` for consistency). Use `getConfig` for uniformity:

```js
    const floorY = getConfig("groundY") + object.halfY - (object.offsetY ?? 0);
```

- [ ] **Step 4: Verify server starts**

Run: `node server/index.js`
Expected: Server starts without errors. Ctrl+C to stop.

- [ ] **Step 5: Commit**

```bash
git add server/game/entities.js server/game/trebuchet.js server/game/simulation.js
git commit -m "refactor: migrate entities, trebuchet, simulation to getConfig()"
```

---

### Task 4: Migrate Server Gameplay Files — physics.js, templateRegistry.js, fragmentation.js

**Files:**
- Modify: `server/game/physics.js`
- Modify: `server/game/templateRegistry.js`
- Modify: `server/game/fragmentation.js`

- [ ] **Step 1: Migrate `server/game/physics.js`**

Replace the `BARRAGE_CONFIG` import (line 17) with `getConfig` added to the existing `SERVER_CONFIG` import:

```js
import { SERVER_CONFIG, getConfig } from "../config.js";
```

Leave all existing `SERVER_CONFIG` references in physics.js unchanged — they're engine-level (gravity) and infrastructure defaults (arena colliders, body creation). Only change the single `BARRAGE_CONFIG` usage.

Replace the `returnDraggedObjectUpright` function's config read (line 333):

```js
  const amount = clamp(getConfig("dragUprightLerp"), 0, 1);
```

- [ ] **Step 2: Migrate `server/game/templateRegistry.js`**

Remove the `BARRAGE_CONFIG` import (line 11). Add `getConfig` import.

Replace line 11:

```js
import { getConfig } from "../config.js";
```

The only `BARRAGE_CONFIG` usage is in `extractTrebuchetNodes` (line 209):

```js
  const restDegrees = BARRAGE_CONFIG.trebuchetArmRestRotationZDegrees ?? 15;
```

Replace with:

```js
  const restDegrees = getConfig("trebuchetArmRestRotationZDegrees");
```

- [ ] **Step 3: Migrate `server/game/fragmentation.js` and export `deleteBlock`**

Remove the `BARRAGE_CONFIG` import (line 6). Combine with the existing `SERVER_CONFIG` import (line 7) into one line:

```js
import { SERVER_CONFIG, getConfig } from "../config.js";
```

Replace `BARRAGE_CONFIG` reads in `shatterBlock` (lines 27-29):

```js
  const spreadX = getConfig("fragmentSpreadX");
  const spreadY = getConfig("fragmentSpreadY");
  const lifetimeMs = getConfig("fragmentLifetimeMs");
```

Replace `BARRAGE_CONFIG` reads in `processFragmentLifecycle` (line 141):

```js
  const shrinkMs = getConfig("fragmentShrinkMs");
```

Export `deleteBlock` — change line 129 from:

```js
function deleteBlock(block) {
```

To:

```js
export function deleteBlock(block) {
```

`SERVER_CONFIG` references in `shatterBlock` (lines 72-74, 93-98) are for fragment physics defaults. Keep these as `SERVER_CONFIG.x` since they're consistent with how `levelRunner.js` creates entities.

- [ ] **Step 4: Verify server starts**

Run: `node server/index.js`
Expected: Server starts without errors. Ctrl+C to stop.

- [ ] **Step 5: Commit**

```bash
git add server/game/physics.js server/game/templateRegistry.js server/game/fragmentation.js
git commit -m "refactor: migrate physics, templateRegistry, fragmentation to getConfig()"
```

---

### Task 5: Collision Hook Refactor

**Files:**
- Modify: `server/game/collisions.js`

This is the most significant logic change. The collision handler becomes config-driven: crack system behavior is controlled by `getConfig("crackSystem")`, and destruction uses either the level hook or config-driven defaults.

- [ ] **Step 1: Rewrite `server/game/collisions.js`**

Replace the `BARRAGE_CONFIG` import with `getConfig` and add `shatterBlock`/`deleteBlock` imports from `fragmentation.js`.

Replace the full file:

```js
import { scene, physicsAggregates } from "./physics.js";
import { gameObjects, gameState } from "./state.js";
import { isMissileName, isBlockName, isFragmentName } from "./entities.js";
import { getActiveLevel, getHookContext } from "./modeRunner.js";
import { broadcast } from "../net/broadcast.js";
import { getConfig, TICK_MS } from "../config.js";
import { shatterBlock, deleteBlock } from "./fragmentation.js";

const pendingBlockHits = new Map();

function objectIdFromBody(body) {
  const name = body.transformNode?.name;
  if (!name) return null;
  const prefix = "physics-";
  return name.startsWith(prefix) ? name.slice(prefix.length) : null;
}

function handleMissileBlockHit(missile, block) {
  if (!block.maxHits) return;
  if (missile.loadedInto) return;
  if (block.removing) return;

  const hitKey = `${missile.id}:${block.id}`;
  const lastTick = pendingBlockHits.get(hitKey);
  if (lastTick === gameState.tick) return;
  pendingBlockHits.set(hitKey, gameState.tick);

  block.hitStage = (block.hitStage ?? 0) + 1;

  if (getConfig("crackSystem") && block.hitStage < block.maxHits) {
    broadcast({
      type: "event",
      tick: gameState.tick,
      events: [{ kind: "blockHit", blockId: block.id, hitStage: block.hitStage }],
    });
  } else {
    const hook = getActiveLevel()?.def.hooks?.onBlockDestroyed;
    if (hook) {
      hook(block, missile, getHookContext());
    } else if (getConfig("fragmentation")) {
      shatterBlock(block, missile);
    } else {
      deleteBlock(block);
    }
  }
}

function handleMissileFragmentHit(missile, fragment) {
  if (fragment.removing) return;
  if (missile.loadedInto) return;

  const immunityMs = getConfig("fragmentImmunityMs");
  const elapsedTicks = gameState.tick - fragment.createdTick;
  if (elapsedTicks * TICK_MS < immunityMs) return;

  fragment.removing = true;
  fragment.removeAfterMs = Date.now() + getConfig("fragmentShrinkMs");

  const aggregate = physicsAggregates.get(fragment.id);
  if (aggregate?.shape) {
    aggregate.shape.isTrigger = true;
  }

  const penalty = getConfig("fragmentHitSpeedPenalty");
  const speed = Math.hypot(missile.vx, missile.vy, missile.vz);
  if (speed > penalty) {
    const scale = (speed - penalty) / speed;
    missile.vx *= scale;
    missile.vy *= scale;
    missile.vz *= scale;
  }

  broadcast({
    type: "event",
    tick: gameState.tick,
    events: [{ kind: "fragmentRemoving", fragId: fragment.id }],
  });
}

export function initCollisions() {
  const plugin = scene.getPhysicsEngine()?.getPhysicsPlugin();
  if (!plugin?.onCollisionObservable) {
    console.warn("No collision observable available — collisions disabled.");
    return;
  }

  plugin.onCollisionObservable.add((event) => {
    if (event.type !== "COLLISION_STARTED") return;

    const idA = objectIdFromBody(event.collider);
    const idB = objectIdFromBody(event.collidedAgainst);
    if (!idA || !idB) return;

    const objA = gameObjects.get(idA);
    const objB = gameObjects.get(idB);
    if (!objA || !objB) return;

    const missileA = isMissileName(idA);
    const missileB = isMissileName(idB);
    if (!missileA && !missileB) return;

    const missile = missileA ? objA : objB;
    const other = missileA ? objB : objA;
    const otherId = missileA ? idB : idA;

    if (isBlockName(otherId) && !isFragmentName(otherId)) {
      handleMissileBlockHit(missile, other);
    } else if (isFragmentName(otherId)) {
      handleMissileFragmentHit(missile, other);
    }
  });
}

export function clearCollisionState() {
  pendingBlockHits.clear();
}
```

- [ ] **Step 2: Verify server starts**

Run: `node server/index.js`
Expected: Server starts without errors. Ctrl+C to stop.

- [ ] **Step 3: Commit**

```bash
git add server/game/collisions.js
git commit -m "refactor: config-driven collision flow — crack system and fragmentation via getConfig()"
```

---

### Task 6: Level Config & LevelRunner Wiring

**Files:**
- Modify: `server/game/levels/level1.js`
- Modify: `server/game/levelRunner.js`

- [ ] **Step 1: Update `server/game/levels/level1.js`**

Add a `config` block and remove the `onBlockDestroyed` hook (config handles it now).

Replace the `hooks` block at the end of the file (lines 96-101):

```js
	config: {
		crackSystem: true,
		fragmentation: true,
	},
```

The full end of the file should look like:

```js
		spawn("trebuchets/trebuche-R", { x: -15, y: 1, player: 1 });
		spawn("trebuchets/trebuche-L", { x: 15, y: 1, player: 2 });
	},

	config: {
		crackSystem: true,
		fragmentation: true,
	},
};
```

The `hooks` block is removed entirely. If custom hooks are needed later, they can be re-added.

- [ ] **Step 2: Wire `setActiveLevelConfig` and `getConfig` into `server/game/levelRunner.js`**

Add `setActiveLevelConfig` and `getConfig` to the imports from `../config.js`. Replace `SERVER_CONFIG` reads in the spawn function with `getConfig()`. Call `setActiveLevelConfig()` inside `loadLevel()` before returning.

Replace lines 10-11 (the config imports):

```js
import { PORT, SERVER_CONFIG, setActiveLevelConfig, getConfig } from "../config.js";
```

Replace the `SERVER_CONFIG` reads in `createSpawnFunction` (lines 85-87) with `getConfig()`:

```js
      mass: getConfig("dynamicMass"),
      friction: getConfig("dynamicFriction"),
      restitution: getConfig("dynamicRestitution"),
```

Add the `setActiveLevelConfig` call just before the return statement in `loadLevel()`. Replace lines 161-169:

```js
  const levelUrl = levelDef.arena ? `/assets/${levelDef.arena}` : null;

  for (const object of gameObjects.values()) {
    console.log(
      `  ${object.id}: pos=(${object.x.toFixed(2)}, ${object.y.toFixed(2)}, ${object.z.toFixed(2)}) half=(${object.halfX.toFixed(2)}, ${object.halfY.toFixed(2)}, ${object.halfZ.toFixed(2)}) player=${object.player}`,
    );
  }

  setActiveLevelConfig(levelDef.config ?? null);

  return { def: levelDef, url: levelUrl, spawn };
```

- [ ] **Step 3: Verify server starts**

Run: `node server/index.js`
Expected: Server starts without errors. Level loads and `setActiveLevelConfig` is called. Ctrl+C to stop.

- [ ] **Step 4: Commit**

```bash
git add server/game/levels/level1.js server/game/levelRunner.js
git commit -m "feat: add level config block to level1, wire setActiveLevelConfig into loadLevel()"
```

---

### Task 7: Server→Client Config Relay

**Files:**
- Modify: `server/net/connections.js`
- Modify: `server/game/modeRunner.js`

- [ ] **Step 1: Include config in `welcome` message — `server/net/connections.js`**

Add `getClientRelevantConfig` import and include `config` in the welcome message.

Replace the config import (line 3) to add `getClientRelevantConfig`:

```js
import { TICK_RATE, getClientRelevantConfig } from "../config.js";
```

Add `config` to the welcome message. Replace lines 16-23:

```js
    socket.send(JSON.stringify({
      type: "welcome",
      clientId,
      playerId,
      tickRate: TICK_RATE,
      level: gameState.currentLevel?.url ?? "/assets/levels/level1.glb",
      templates: getAllPaths(),
      config: getClientRelevantConfig(),
    }));
```

- [ ] **Step 2: Include config in `roundStarted` and `matchReset` broadcasts — `server/game/modeRunner.js`**

Add `getClientRelevantConfig` import and include `config` in both broadcast calls.

Add import at the top. Replace line 1 area — add this import alongside existing ones:

```js
import { getClientRelevantConfig } from "../config.js";
```

Replace the `roundStarted` broadcast (lines 221-226):

```js
    broadcast({
      type: "roundStarted",
      roundNumber: gameState.roundNumber,
      scores: gameState.scores,
      level: activeLevel.url,
      config: getClientRelevantConfig(),
    });
```

Replace the `matchReset` broadcast (lines 248-253):

```js
    broadcast({
      type: "matchReset",
      roundNumber: gameState.roundNumber,
      scores: gameState.scores,
      level: activeLevel.url,
      config: getClientRelevantConfig(),
    });
```

- [ ] **Step 3: Verify server starts**

Run: `node server/index.js`
Expected: Server starts without errors. Ctrl+C to stop.

- [ ] **Step 4: Commit**

```bash
git add server/net/connections.js server/game/modeRunner.js
git commit -m "feat: include resolved config in welcome, roundStarted, matchReset messages"
```

---

### Task 8: Migrate Client Files

**Files:**
- Modify: `public/client/engine.js`
- Modify: `public/client/network.js`
- Modify: `public/client/aim.js`
- Modify: `public/client/input.js`
- Modify: `public/client/level.js`

- [ ] **Step 1: Migrate `public/client/engine.js`**

Replace the `BARRAGE_CONFIG` import with `CLIENT_CONFIG`. Update the `CONFIG` alias.

Replace lines 1-3:

```js
import { CLIENT_CONFIG } from "./clientConfig.js";

export const CONFIG = CLIENT_CONFIG;
```

The rest of the file uses `CONFIG.x` which now resolves to `CLIENT_CONFIG.x`. All keys used in `engine.js` are client-only (exposure, contrast), so no changes needed beyond the import.

- [ ] **Step 2: Add `serverConfig` relay to `public/client/network.js`**

Add state for server config and a `getServerConfig` accessor. Store config from `welcome`, `roundStarted`, and `matchReset` messages.

Add after line 7 (`let ready = false;`):

```js
let serverConfig = {};

export function getServerConfig(key) {
  return serverConfig[key];
}
```

In the `welcome` handler (after line 98), add config storage:

```js
  if (message.type === "welcome") {
    if (message.config) serverConfig = message.config;
    playerEl.textContent = message.playerId;
```

In the `roundStarted` handler (after line 114), add config storage:

```js
  if (message.type === "roundStarted") {
    if (message.config) serverConfig = message.config;
    clearDestructionVisuals();
```

In the `matchReset` handler (after line 127), add config storage:

```js
  if (message.type === "matchReset") {
    if (message.config) serverConfig = message.config;
    matchEndEl.classList.add("hidden");
```

- [ ] **Step 3: Migrate `public/client/aim.js`**

`aim.js` uses `CONFIG` (from `engine.js`) for all aim arrow visual settings. After migration, `CONFIG` = `CLIENT_CONFIG` which has arrow visuals but not gameplay values. Two values come from the server:

- `trebuchetArmRestRotationZDegrees` (line 98) — server config
- `aimMaxPullDistance` (line 150/162) — server config, determines max arrow length

Server `aimMaxPullDistance` must take precedence over `CLIENT_CONFIG.aimArrowMaxLength` for the arrow clamping and color gradient, so level overrides to pull distance are reflected visually.

Add `getServerConfig` import:

```js
import { scene, CONFIG } from "./engine.js";
import { getServerConfig } from "./network.js";
```

Replace line 98 in `releasePointForTrebuchet`:

```js
  const restRadians = degreesToRadians(getServerConfig("trebuchetArmRestRotationZDegrees") ?? 15);
```

Replace lines 150-152 (`clampAimTailPoint` call and both z-offset lines). Compute `maxArrowLength` from server config with client fallback, then pass a minimal config object (avoids per-frame object spread):

```js
  const maxArrowLength = getServerConfig("aimMaxPullDistance") ?? CONFIG.aimArrowMaxLength ?? 4.5;
  const tailPoint = clampAimTailPoint(headPoint, aimWorldPoint.clone(), { aimArrowMaxLength: maxArrowLength });
  tailPoint.z = headPoint.z + (CONFIG.aimArrowZOffset ?? 0.05);
  headPoint.z += CONFIG.aimArrowZOffset ?? 0.05;
```

Replace line 162 (`extensionRatio` calc) — reuse the same `maxArrowLength`:

```js
  const extensionRatio = arrowLength / Math.max(0.001, maxArrowLength);
```

- [ ] **Step 4: Migrate `public/client/input.js`**

`input.js` uses `CONFIG` (from `engine.js`) for input settings and drag/release values. All values used are client-only except `normalReleaseVelocityMax` (line 97), which is now a server config value.

Add `getServerConfig` import:

```js
import { scene, canvas, resetEl, restartServerEl, connectionEl, CONFIG } from "./engine.js";
import { getServerConfig } from "./network.js";
```

Replace line 97 in `averageReleaseVelocity` — use server value with hardcoded fallback (CONFIG no longer has this key):

```js
  }, getServerConfig("normalReleaseVelocityMax") ?? 8);
```

All other `CONFIG.x` reads in `input.js` are client-only values (`trebuchetInputInvertX`, `inputInvertX`, `inputInvertY`, `inputInvertZ`, `releaseVelocityFrameWindow`, `releaseVelocitySampleHz`, `releaseVelocityScale`, `dragHeightOffset`, `cameraControlsEnabled`) — these stay as `CONFIG.x`.

- [ ] **Step 5: Migrate `public/client/level.js`**

`level.js` uses `CONFIG` (from `engine.js`) for rendering settings. The only non-client value is `fragmentShrinkMs` (line 287 — currently reads `window.BARRAGE_CONFIG?.fragmentShrinkMs`).

Add `getServerConfig` import:

```js
import { engine, scene, canvas, CONFIG } from "./engine.js";
import { getServerConfig } from "./network.js";
```

Replace line 287 in `shrinkAndDisposeFragment`:

```js
  const shrinkMs = (getServerConfig("fragmentShrinkMs") ?? 500);
```

All other `CONFIG.x` reads in `level.js` are client-only values (`cameraControlsEnabled`, `fallbackLightIntensity`, `importedLightIntensityScale`, `shadowsEnabled`, `shadowMapSize`, `shadowBias`, `shadowNormalBias`, `missilePickColliderScale`) — these stay as `CONFIG.x`.

- [ ] **Step 6: Verify client loads in browser**

Open the game in a browser. Verify:
- Game loads without console errors
- Aim arrow renders correctly when pulling back a loaded missile
- Block crack stages and fragment destruction work
- Fragment shrink animation plays

- [ ] **Step 7: Commit**

```bash
git add public/client/engine.js public/client/network.js public/client/aim.js public/client/input.js public/client/level.js
git commit -m "refactor: migrate client files from BARRAGE_CONFIG to CLIENT_CONFIG + getServerConfig()"
```

---

### Task 9: Delete public/config.js & Integration Verification

**Files:**
- Delete: `public/config.js`

- [ ] **Step 1: Verify no remaining imports of `public/config.js`**

Run: `grep -r "public/config.js\|BARRAGE_CONFIG\|window.BARRAGE_CONFIG" --include="*.js" server/ public/`

Expected: No matches (all references should be migrated by now). If there are matches, fix them before proceeding.

- [ ] **Step 2: Delete `public/config.js`**

```bash
git rm public/config.js
```

- [ ] **Step 3: Start the server and run a full game test**

Run: `node server/index.js`

Open two browser tabs to `http://localhost:3000`. Verify the full gameplay loop:
1. Both players connect and see the arena
2. Dragging blocks works (respects half-field restriction)
3. Loading missiles into trebuchets works
4. Aiming and firing works (aim arrow renders, missile launches)
5. Block hit → crack stage visual appears
6. Block final hit → block shatters into fragments
7. Fragments shrink and disappear after timeout
8. Fragment hit by missile → fragment begins shrinking, missile slows
9. King knocked over → round ends, scores update
10. New round starts with fresh level
11. Match win → match end screen, rematch works

- [ ] **Step 4: Commit**

```bash
git commit -m "feat: delete public/config.js — config separation complete"
```
