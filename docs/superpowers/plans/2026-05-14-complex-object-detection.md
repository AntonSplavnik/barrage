# Complex Object Detection & Fragmentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add convex hull physics shapes, collision detection, damage progression (crack stages), and block fragmentation (shattering into physics-driven pieces).

**Architecture:** Template registry pre-extracts vertex data from GLB meshes at startup. Physics system gains shape-aware body creation (box/sphere/convex_hull). A new collision module registers Havok collision observables and dispatches missile→block/king/fragment contacts. A new fragmentation module handles shattering blocks into physics-driven pieces with lifecycle management. Client handles visual crack stages, fragment rendering, and shrink animations.

**Tech Stack:** Babylon.js v2 physics (Havok), Node.js ES modules, WebSocket events

**Spec:** `docs/superpowers/specs/2026-05-14-complex-object-detection-design.md`

---

## File Structure

### New files:
- `server/game/collisions.js` — Registers Havok collision observable, dispatches contact pairs to handlers
- `server/game/fragmentation.js` — `shatterBlock()`, fragment lifecycle, time-based removal

### Modified files:
- `public/config.js` — Fragment config values
- `server/game/templateRegistry.js` — `childRole("Frag")`, convex positions extraction, hit stage + fragment detection
- `server/game/physics.js` — `childRole("Frag")`, shape-aware `createPhysicsBodies()`, `createConvexHullBody()` helper
- `server/game/entities.js` — `isBlockName()`, `isFragmentName()`, `toWireObject()` additions
- `server/game/levelRunner.js` — Spawn function passes `shape`/`fragmentTemplate`, `clearScene` exported
- `server/game/levels/level1.js` — `shape` params, `fragmentTemplate` links, `onBlockDestroyed` hook
- `server/game/loop.js` — Calls fragment lifecycle processing each tick
- `server/game/modeRunner.js` — `getHookContext()` includes `shatterBlock`, `resetRoundState` clears fragment fields
- `public/client/utils.js` — `childRole("Frag")` support
- `public/client/level.js` — Crack stage mesh swapping, fragment per-piece cloning, shrink animation
- `public/client/state.js` — `hitStage` visual updates in `applyState()`
- `public/client/network.js` — `blockHit`, `blockBroken`, `fragmentRemoving` event handlers

---

### Task 1: Config values and entity helpers

**Files:**
- Modify: `public/config.js`
- Modify: `server/game/entities.js`
- Modify: `server/game/templateRegistry.js:21-26`
- Modify: `server/game/physics.js:46-51`
- Modify: `public/client/utils.js:9-14`

- [ ] **Step 1: Add fragment config values**

Add to `public/config.js`, after the `aimArrowHeadWidthScale` line (line 65):

```js
  // Fragment / destruction.
  fragmentLifetimeMs: 5000,
  fragmentSpreadX: 4,
  fragmentSpreadY: 2,
  fragmentShrinkMs: 500,
  fragmentImmunityMs: 500,
  fragmentHitSpeedPenalty: 3,
```

- [ ] **Step 2: Add `"Frag"` to `childRole()` in `server/game/templateRegistry.js`**

Replace the `childRole` function (lines 21–26):

```js
function childRole(name) {
  if (name.includes("Frag")) return "Frag";
  if (name.includes("ColVis")) return "ColVis";
  if (name.includes("Visual") || name.includes("Vis")) return "Vis";
  if (name.includes("Collider") || name.includes("Col")) return "Col";
  return null;
}
```

- [ ] **Step 3: Add `"Frag"` to `childRole()` in `server/game/physics.js`**

Replace the `childRole` function (lines 46–51):

```js
function childRole(name) {
  if (name.includes("Frag")) return "Frag";
  if (name.includes("ColVis")) return "ColVis";
  if (name.includes("Visual") || name.includes("Vis")) return "Vis";
  if (name.includes("Collider") || name.includes("Col")) return "Col";
  return null;
}
```

- [ ] **Step 4: Add `"Frag"` to `childRole()` in `public/client/utils.js`**

Replace the `childRole` function (lines 9–14):

```js
export function childRole(name) {
  if (name.includes("Frag")) return "Frag";
  if (name.includes("ColVis")) return "ColVis";
  if (name.includes("Visual") || name.includes("Vis")) return "Vis";
  if (name.includes("Collider") || name.includes("Col")) return "Col";
  return null;
}
```

- [ ] **Step 5: Add entity helpers and wire format fields in `server/game/entities.js`**

Add after `isKingName` (line 38):

```js
export function isBlockName(name) {
  return name.startsWith("blocks/");
}

export function isFragmentName(name) {
  return name.startsWith("blocks/") && name.includes("_frag_");
}
```

Update `toWireObject` (line 10) — replace the entire function:

```js
export function toWireObject(object) {
  return {
    id: object.id,
    x: object.x,
    y: object.y,
    z: object.z,
    rot: object.rot,
    vx: object.vx,
    vy: object.vy,
    vz: object.vz,
    ...(object.player != null ? { player: object.player } : {}),
    ...(object.loaded !== undefined ? { loaded: object.loaded } : {}),
    ...(object.loadedInto ? { loadedInto: object.loadedInto } : {}),
    ...(object.armAngle !== undefined ? { armAngle: object.armAngle, fireState: object.fireState } : {}),
    ...(object.hits !== undefined ? { hits: object.hits, maxHits: object.maxHits } : {}),
    ...(object.hitStage !== undefined ? { hitStage: object.hitStage } : {}),
    ...(!object.isFragment && object.fragmentTemplate ? { fragmentTemplate: object.fragmentTemplate } : {}),
    ...(object.isFragment ? { isFragment: true, pieceIndex: object.pieceIndex, fragmentTemplate: object.fragmentTemplate } : {}),
  };
}
```

- [ ] **Step 6: Commit**

```bash
git add public/config.js server/game/templateRegistry.js server/game/physics.js server/game/entities.js public/client/utils.js
git commit -m "feat: add fragment config, Frag child role, entity helpers and wire format"
```

---

### Task 2: Template registry — convex positions and destructible detection

**Files:**
- Modify: `server/game/templateRegistry.js`

- [ ] **Step 1: Add imports for vertex extraction**

Add to the existing imports at the top of `server/game/templateRegistry.js`, after line 8 (`import { scene } from "./physics.js";`):

```js
import { Matrix } from "@babylonjs/core/Maths/math.vector.js";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
```

Update the existing `Vector3` import (line 5) to also import `Matrix` — or add the `Matrix` import separately. Use whichever approach avoids duplicate `@babylonjs/core/Maths/math.vector.js` imports. The cleanest approach:

Replace line 5:
```js
import { Vector3, Matrix } from "@babylonjs/core/Maths/math.vector.js";
```

And add after line 8:
```js
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
```

- [ ] **Step 2: Add `extractConvexPositions` function**

Add after the `colliderBoundsFor` function (after line 102):

```js
function extractConvexPositions(root) {
  const descendants = descendantsOf(root);
  const colliderMeshes = descendants.filter((child) => {
    const role = childRole(child.name);
    return (role === "Col" || role === "ColVis")
      && typeof child.getVerticesData === "function"
      && child.getTotalVertices?.() > 0;
  });

  const fallbackNodes = [root, ...descendants].filter(
    (node) => typeof node.getVerticesData === "function" && node.getTotalVertices?.() > 0,
  );
  const meshes = colliderMeshes.length > 0 ? colliderMeshes : fallbackNodes;
  if (meshes.length === 0) return null;

  root.computeWorldMatrix(true);
  const rootWorldInverse = root.getWorldMatrix().clone().invert();
  const allPositions = [];

  for (const mesh of meshes) {
    mesh.computeWorldMatrix(true);
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    if (!positions) continue;

    const localMatrix = mesh.getWorldMatrix().multiply(rootWorldInverse);

    for (let i = 0; i < positions.length; i += 3) {
      const v = Vector3.TransformCoordinates(
        new Vector3(positions[i], positions[i + 1], positions[i + 2]),
        localMatrix,
      );
      allPositions.push(v.x, v.y, v.z);
    }
  }

  return allPositions.length > 0 ? new Float32Array(allPositions) : null;
}
```

- [ ] **Step 3: Add `detectHitStages` function**

Add after `extractConvexPositions`:

```js
function detectHitStages(root) {
  const descendants = descendantsOf(root);
  const hitPattern = /hit(\d+)-Visual/;
  const stages = [];

  for (const child of descendants) {
    const match = child.name.match(hitPattern);
    if (match) {
      stages.push({ index: parseInt(match[1], 10), name: child.name });
    }
  }

  stages.sort((a, b) => a.index - b.index);
  return stages.map((s) => s.name);
}
```

- [ ] **Step 4: Add `detectFragments` function**

Add after `detectHitStages`:

```js
function detectFragments(root) {
  const descendants = descendantsOf(root);
  const fragPattern = /Frag\.(\d+)/;
  const pieces = [];

  for (const child of descendants) {
    const match = child.name.match(fragPattern);
    if (!match) continue;

    const pieceNum = parseInt(match[1], 10);
    child.computeWorldMatrix(true);

    const localPos = child.getAbsolutePosition().subtract(root.getAbsolutePosition());
    const bounds = colliderBoundsFor(child);
    const convexPositions = extractConvexPositions(child);

    pieces.push({
      pieceNum,
      pieceIndex: 0,
      localX: localPos.x,
      localY: localPos.y,
      localZ: localPos.z,
      halfX: bounds.halfX,
      halfY: bounds.halfY,
      halfZ: bounds.halfZ,
      offsetX: bounds.offsetX,
      offsetY: bounds.offsetY,
      offsetZ: bounds.offsetZ,
      convexPositions,
    });
  }

  pieces.sort((a, b) => a.pieceNum - b.pieceNum);
  pieces.forEach((p, i) => { p.pieceIndex = i; });
  return pieces;
}
```

- [ ] **Step 5: Update `initTemplateRegistry` to cache convex positions, hit stages, and fragments**

Replace the template caching block inside the `for` loop in `initTemplateRegistry` (lines 175–185):

```js
    const bounds = colliderBoundsFor(newRoot);
    const convexPositions = extractConvexPositions(newRoot);
    const isTrebuchet = templatePath.startsWith("trebuchets/");
    const trebuchetNodes = isTrebuchet ? extractTrebuchetNodes(newRoot) : null;

    const hitStages = detectHitStages(newRoot);
    const fragments = detectFragments(newRoot);
    const isDestructible = hitStages.length > 0 || fragments.length > 0;

    templateCache.set(templatePath, {
      bounds,
      convexPositions,
      ...(isDestructible ? { hitStages, fragments } : {}),
      ...(trebuchetNodes ?? {}),
    });

    console.log(
      `Template "${templatePath}": half=(${bounds.halfX.toFixed(2)}, ${bounds.halfY.toFixed(2)}, ${bounds.halfZ.toFixed(2)})`
      + (convexPositions ? ` vertices=${convexPositions.length / 3}` : "")
      + (hitStages.length > 0 ? ` hitStages=${hitStages.length}` : "")
      + (fragments.length > 0 ? ` fragments=${fragments.length}` : ""),
    );
```

- [ ] **Step 6: Start the server and verify template loading output**

Run: `npm run dev`

Expected console output should show vertex counts and fragment/hitStage counts for destructible templates:
```
Template "blocks/fragmented-L": half=(…) vertices=… hitStages=4 fragments=8
Template "blocks/fragmented-R": half=(…) vertices=… hitStages=4 fragments=8
Template "kings/default-L": half=(…) vertices=…
```

If `hitStages=0` and `fragments=0` for fragmented blocks, the GLB naming convention doesn't match — check the mesh names in the GLB files.

- [ ] **Step 7: Commit**

```bash
git add server/game/templateRegistry.js
git commit -m "feat: extract convex positions and detect destructible template data"
```

---

### Task 3: Physics — shape-aware body creation and convex hull helper

**Files:**
- Modify: `server/game/physics.js`

- [ ] **Step 1: Add new imports**

Add to the imports in `server/game/physics.js`:

After the `TransformNode` import (line 9):
```js
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
```

Add `isBlockName` to the `entities.js` import (line 17):
```js
import { isTrebuchetName, isMissileName, isBlockName } from "./entities.js";
```

Add the template registry import after line 18:
```js
import { getTemplate } from "./templateRegistry.js";
```

- [ ] **Step 2: Add `createConvexHullBody` helper**

Add after the `disposeArenaColliders` function (after line 121):

```js
function fanIndices(vertexCount) {
  const indices = [];
  for (let i = 1; i < vertexCount - 1; i++) {
    indices.push(0, i, i + 1);
  }
  return indices;
}

export function createConvexHullBody(id, positions, position, rotation, physicsOptions) {
  const mesh = new Mesh(`physics-${id}`, scene);
  const vertexData = new VertexData();
  vertexData.positions = positions;
  vertexData.indices = fanIndices(positions.length / 3);
  vertexData.applyToMesh(mesh);

  mesh.position.copyFrom(position);
  mesh.rotationQuaternion = rotation;
  mesh.computeWorldMatrix(true);

  const aggregate = new PhysicsAggregate(mesh, PhysicsShapeType.CONVEX_HULL, {
    mass: physicsOptions.mass ?? 0,
    friction: physicsOptions.friction ?? SERVER_CONFIG.dynamicFriction,
    restitution: physicsOptions.restitution ?? SERVER_CONFIG.dynamicRestitution,
  }, scene);

  return aggregate;
}
```

- [ ] **Step 3: Update `createPhysicsBodies` for shape-aware creation**

Replace the `createPhysicsBodies` function (lines 123–145):

```js
function templatePathFromId(objectId) {
  const lastUnderscore = objectId.lastIndexOf("_");
  if (lastUnderscore < 0) return objectId;
  return objectId.substring(0, lastUnderscore);
}

export function createPhysicsBodies() {
  for (const object of gameObjects.values()) {
    const shape = object.shape ?? (isMissileName(object.id) ? "sphere" : "box");
    let aggregate;

    if (shape === "convex_hull") {
      const template = getTemplate(templatePathFromId(object.id));
      if (template?.convexPositions) {
        aggregate = createConvexHullBody(
          object.id,
          template.convexPositions,
          new Vector3(object.x, object.y, object.z),
          rotationQuaternionForObject(object),
          {
            mass: object.dynamic ? object.mass : 0,
            friction: object.friction,
            restitution: object.restitution,
          },
        );
      } else {
        console.warn(`No convex positions for "${object.id}", falling back to BOX`);
        aggregate = createBoxBody(object);
      }
    } else if (shape === "sphere") {
      aggregate = createSphereBody(object);
    } else {
      aggregate = createBoxBody(object);
    }

    aggregate.body.disablePreStep = true;
    aggregate.body.setLinearDamping(isTrebuchetName(object.id) ? 2.2 : 0.15);
    aggregate.body.setAngularDamping(isTrebuchetName(object.id) ? 10 : 0.55);

    if (isMissileName(object.id) || isBlockName(object.id)) {
      aggregate.body.setCollisionCallbackEnabled(true);
    }

    physicsAggregates.set(object.id, aggregate);
  }
}

function createBoxBody(object) {
  const node = new TransformNode(`physics-${object.id}`, scene);
  node.position.set(object.x, object.y, object.z);
  node.rotationQuaternion = rotationQuaternionForObject(object);

  return new PhysicsAggregate(node, PhysicsShapeType.BOX, {
    mass: object.dynamic ? object.mass : 0,
    friction: object.friction,
    restitution: object.restitution,
    center: new Vector3(object.offsetX, object.offsetY, object.offsetZ),
    extents: new Vector3(object.halfX * 2, object.halfY * 2, object.halfZ * 2),
  }, scene);
}

function createSphereBody(object) {
  const node = new TransformNode(`physics-${object.id}`, scene);
  node.position.set(object.x, object.y, object.z);
  node.rotationQuaternion = rotationQuaternionForObject(object);

  return new PhysicsAggregate(node, PhysicsShapeType.SPHERE, {
    mass: object.dynamic ? object.mass : 0,
    friction: object.friction,
    restitution: object.restitution,
    radius: Math.max(object.halfX, object.halfY, object.halfZ),
  }, scene);
}
```

- [ ] **Step 4: Start the server and verify physics bodies still work**

Run: `npm run dev`

Open browser at `http://localhost:3000`. Verify:
- Blocks, kings, missiles, trebuchets all appear and physics works
- Dragging and firing still work
- Console shows no errors

- [ ] **Step 5: Commit**

```bash
git add server/game/physics.js
git commit -m "feat: shape-aware physics body creation with convex hull support"
```

---

### Task 4: Level runner — spawn function and clearScene updates

**Files:**
- Modify: `server/game/levelRunner.js`

- [ ] **Step 1: Update spawn function to pass `shape` and `fragmentTemplate`**

In `createSpawnFunction` (line 42), update the object creation inside the `spawn` function. After the `player` field (line 87) and before the trebuchet conditional (line 88), add the shape and fragment fields:

```js
      player: opts.player ?? null,
      ...(opts.shape ? { shape: opts.shape } : {}),
      ...(opts.fragmentTemplate ? (() => {
        const fragTemplate = getTemplate(opts.fragmentTemplate);
        if (!fragTemplate) {
          console.warn(`Fragment template "${opts.fragmentTemplate}" not found for ${id}`);
        }
        const hitStages = fragTemplate?.hitStages ?? [];
        return {
          fragmentTemplate: opts.fragmentTemplate,
          hitStage: 0,
          maxHits: hitStages.length + 1,
        };
      })() : {}),
```

- [ ] **Step 2: Export `clearScene`**

Change the `clearScene` function declaration (line 27) from:

```js
function clearScene() {
```

To:

```js
export function clearScene() {
```

- [ ] **Step 3: Commit**

```bash
git add server/game/levelRunner.js
git commit -m "feat: spawn function passes shape and fragmentTemplate, export clearScene"
```

---

### Task 5: Level config — shape params, fragmentTemplate, hooks

**Files:**
- Modify: `server/game/levels/level1.js`

- [ ] **Step 1: Update level1.js with shape params and fragment links**

Replace the entire file:

```js
// server/game/levels/level1.js
export default {
  arena: "levels/level1.glb",

  setup(spawn) {
    spawn("trebuchets/basic", { x: -25, y: 1, player: 1 });
    spawn("trebuchets/basic", { x: 25, y: 1, player: 2 });

    spawn("kings/default-L", { x: -37, y: 1.05, player: 1, shape: "convex_hull" });
    spawn("kings/default-R", { x: 37, y: 1.05, player: 2, shape: "convex_hull" });

    spawn("blocks/defarult-L", { x: -12, y: 1, fragmentTemplate: "blocks/fragmented-L" });
    spawn("blocks/defarult-L", { x: -12, y: 9, rotation: 45, fragmentTemplate: "blocks/fragmented-L" });
    spawn("blocks/fragmented-L", { x: 12, y: 1 });
    spawn("blocks/fragmented-R", { x: 12, y: 9, rotation: -45 });

    spawn("missiles/basic", { x: 0, y: 0.5 });
    spawn("missiles/basic", { x: 0, y: 6 });
  },

  hooks: {
    onBlockDestroyed(block, missile, ctx) {
      ctx.shatterBlock(block, missile);
    },
  },
};
```

- [ ] **Step 2: Start server and verify spawning still works**

Run: `npm run dev`

Open browser. Verify all objects spawn correctly. Kings should now use convex hull shapes (visually the same, but more accurate collision).

- [ ] **Step 3: Commit**

```bash
git add server/game/levels/level1.js
git commit -m "feat: level1 uses convex_hull kings, fragmentTemplate links, onBlockDestroyed hook"
```

---

### Task 6: Collision detection system

**Files:**
- Create: `server/game/collisions.js`
- Modify: `server/game/loop.js`

- [ ] **Step 1: Create `server/game/collisions.js`**

```js
import { scene, physicsAggregates } from "./physics.js";
import { gameObjects, gameState } from "./state.js";
import { isMissileName, isBlockName, isKingName, isFragmentName } from "./entities.js";
import { getActiveLevel, getHookContext, callHook } from "./modeRunner.js";
import { broadcast } from "../net/broadcast.js";
import { BARRAGE_CONFIG } from "../../public/config.js";

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

  if (block.hitStage < block.maxHits) {
    broadcast({
      type: "event",
      tick: gameState.tick,
      events: [{ kind: "blockHit", blockId: block.id, hitStage: block.hitStage }],
    });
  } else {
    callHook(getActiveLevel()?.def.hooks?.onBlockDestroyed, block, missile, getHookContext());
  }
}

function handleMissileFragmentHit(missile, fragment) {
  if (fragment.removing) return;
  if (missile.loadedInto) return;

  const immunityMs = BARRAGE_CONFIG.fragmentImmunityMs ?? 500;
  const tickMs = 1000 / 60;
  const elapsedTicks = gameState.tick - fragment.createdTick;
  if (elapsedTicks * tickMs < immunityMs) return;

  fragment.removing = true;
  fragment.removeAfterMs = Date.now() + (BARRAGE_CONFIG.fragmentShrinkMs ?? 500);

  const aggregate = physicsAggregates.get(fragment.id);
  if (aggregate?.shape) {
    aggregate.shape.isTrigger = true;
  }

  const penalty = BARRAGE_CONFIG.fragmentHitSpeedPenalty ?? 3;
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

- [ ] **Step 2: Wire collisions into the game loop**

Update `server/game/loop.js`. Replace the entire file:

```js
import { gameState } from "./state.js";
import { TICK_MS } from "../config.js";
import { simulatePhysics } from "./simulation.js";
import { checkRoundEnd } from "./modeRunner.js";
import { sendState } from "../net/broadcast.js";
import { processFragmentLifecycle } from "./fragmentation.js";

let simulationInterval = null;

export function startGameLoop() {
  simulationInterval = setInterval(() => {
    if (gameState.paused) return;
    gameState.tick += 1;
    simulatePhysics();
    processFragmentLifecycle();
    checkRoundEnd();
    sendState();
  }, TICK_MS);
}

export function stopGameLoop() {
  if (simulationInterval) {
    clearInterval(simulationInterval);
    simulationInterval = null;
  }
}
```

- [ ] **Step 2b: Create stub `server/game/fragmentation.js`**

This stub allows `loop.js` to import without errors. It will be replaced with the full implementation in Task 7.

```js
export function shatterBlock() {}
export function processFragmentLifecycle() {}
```

- [ ] **Step 3: Initialize collisions in `server/index.js`**

Add import after the `startGameLoop` import (line 13):

```js
import { initCollisions } from "./game/collisions.js";
```

Add `initCollisions()` call after `startMode(classicMode)` (after line 118) and before `startGameLoop()`:

```js
initCollisions();
```

- [ ] **Step 4: Commit**

```bash
git add server/game/collisions.js server/game/fragmentation.js server/game/loop.js server/index.js
git commit -m "feat: collision detection system with missile-block and missile-fragment handlers"
```

---

### Task 7: Fragmentation system

**Files:**
- Create: `server/game/fragmentation.js`
- Modify: `server/game/modeRunner.js`

- [ ] **Step 1: Create `server/game/fragmentation.js`**

```js
import { Vector3, Quaternion } from "@babylonjs/core/Maths/math.vector.js";
import { physicsAggregates, createConvexHullBody } from "./physics.js";
import { gameObjects, gameState } from "./state.js";
import { getTemplate } from "./templateRegistry.js";
import { broadcast } from "../net/broadcast.js";
import { BARRAGE_CONFIG } from "../../public/config.js";
import { SERVER_CONFIG } from "../config.js";

function randomSpread(max) {
  return (Math.random() - 0.5) * 2 * max;
}

export function shatterBlock(block, missile) {
  if (!block.fragmentTemplate) return;

  const template = getTemplate(block.fragmentTemplate);
  if (!template?.fragments || template.fragments.length === 0) {
    deleteBlock(block);
    return;
  }

  const fragIds = [];
  const blockRot = (block.rot ?? 0) * Math.PI / 180;
  const cosR = Math.cos(blockRot);
  const sinR = Math.sin(blockRot);

  const spreadX = BARRAGE_CONFIG.fragmentSpreadX ?? 4;
  const spreadY = BARRAGE_CONFIG.fragmentSpreadY ?? 2;
  const lifetimeMs = BARRAGE_CONFIG.fragmentLifetimeMs ?? 5000;

  const missileSpeed = Math.hypot(missile.vx ?? 0, missile.vy ?? 0, missile.vz ?? 0);
  const missileDir = missileSpeed > 0.01
    ? { x: missile.vx / missileSpeed, y: missile.vy / missileSpeed }
    : { x: 1, y: 0 };

  for (const frag of template.fragments) {
    const rotatedX = frag.localX * cosR - frag.localY * sinR;
    const rotatedY = frag.localX * sinR + frag.localY * cosR;

    const worldX = block.x + rotatedX;
    const worldY = block.y + rotatedY;
    const worldZ = block.z + (frag.localZ ?? 0);

    const fragId = `${block.id}_frag_${frag.pieceIndex}`;

    const fragObj = {
      id: fragId,
      x: worldX,
      y: worldY,
      z: worldZ,
      originX: worldX,
      originY: worldY,
      originZ: worldZ,
      rot: block.rot ?? 0,
      originRot: 0,
      angularVelocity: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      dragVx: 0,
      dragVy: 0,
      dragVz: 0,
      dynamic: true,
      draggedBy: null,
      offsetX: frag.offsetX,
      offsetY: frag.offsetY,
      offsetZ: frag.offsetZ,
      halfX: frag.halfX,
      halfY: frag.halfY,
      halfZ: frag.halfZ,
      halfHeight: frag.halfY,
      mass: SERVER_CONFIG.dynamicMass,
      friction: SERVER_CONFIG.dynamicFriction,
      restitution: SERVER_CONFIG.dynamicRestitution,
      player: null,
      isFragment: true,
      parentBlockId: block.id,
      createdTick: gameState.tick,
      pieceIndex: frag.pieceIndex,
      fragmentTemplate: block.fragmentTemplate,
      expiresAt: Date.now() + lifetimeMs,
      removing: false,
      removeAfterMs: null,
    };

    gameObjects.set(fragId, fragObj);

    if (frag.convexPositions) {
      const aggregate = createConvexHullBody(
        fragId,
        frag.convexPositions,
        new Vector3(worldX, worldY, worldZ),
        Quaternion.FromEulerAngles(0, 0, blockRot),
        {
          mass: SERVER_CONFIG.dynamicMass,
          friction: SERVER_CONFIG.dynamicFriction,
          restitution: SERVER_CONFIG.dynamicRestitution,
        },
      );
      aggregate.body.disablePreStep = true;
      aggregate.body.setLinearDamping(0.15);
      aggregate.body.setAngularDamping(0.55);
      aggregate.body.setCollisionCallbackEnabled(true);

      const impactVx = missileDir.x * missileSpeed * 0.3 + randomSpread(spreadX);
      const impactVy = missileDir.y * missileSpeed * 0.3 + Math.abs(randomSpread(spreadY));
      aggregate.body.setLinearVelocity(new Vector3(impactVx, impactVy, 0));
      aggregate.body.setAngularVelocity(new Vector3(0, 0, randomSpread(8)));

      physicsAggregates.set(fragId, aggregate);
    }

    fragIds.push({ id: fragId, pieceIndex: frag.pieceIndex });
  }

  broadcast({
    type: "event",
    tick: gameState.tick,
    events: [{
      kind: "blockBroken",
      blockId: block.id,
      fragIds,
    }],
  });

  deleteBlock(block);
}

function deleteBlock(block) {
  const aggregate = physicsAggregates.get(block.id);
  if (aggregate) {
    aggregate.dispose();
    physicsAggregates.delete(block.id);
  }
  gameObjects.delete(block.id);
}

export function processFragmentLifecycle() {
  const now = Date.now();
  const shrinkMs = BARRAGE_CONFIG.fragmentShrinkMs ?? 500;

  for (const object of gameObjects.values()) {
    if (!object.isFragment) continue;

    if (object.removing && object.removeAfterMs && now >= object.removeAfterMs) {
      const aggregate = physicsAggregates.get(object.id);
      if (aggregate) {
        aggregate.dispose();
        physicsAggregates.delete(object.id);
      }
      gameObjects.delete(object.id);
      continue;
    }

    if (!object.removing && now >= object.expiresAt) {
      object.removing = true;
      object.removeAfterMs = now + shrinkMs;

      const aggregate = physicsAggregates.get(object.id);
      if (aggregate?.shape) {
        aggregate.shape.isTrigger = true;
      }

      broadcast({
        type: "event",
        tick: gameState.tick,
        events: [{ kind: "fragmentRemoving", fragId: object.id }],
      });
    }
  }
}
```

- [ ] **Step 2: Update `modeRunner.js` hook context with `shatterBlock`**

Add import at the top of `server/game/modeRunner.js` (after line 6):

```js
import { shatterBlock } from "./fragmentation.js";
import { clearCollisionState } from "./collisions.js";
```

Update `getHookContext()` (line 22) to include `shatterBlock`:

```js
export function getHookContext() {
  return {
    spawn: activeLevel?.spawn ?? (() => {}),
    gameObjects,
    broadcast,
    gameState,
    activeMode,
    activeLevel,
    shatterBlock,
  };
}
```

- [ ] **Step 3: Update `resetRoundState` to clear fragment fields and collision state**

In `resetRoundState()` (line 42), add at the beginning of the function (after `dragState.clear()`):

```js
  clearCollisionState();

  for (const [id, obj] of gameObjects) {
    if (obj.isFragment) {
      physicsAggregates.get(id)?.dispose();
      physicsAggregates.delete(id);
      gameObjects.delete(id);
    }
  }
```

Add the `physicsAggregates` import at the top of `modeRunner.js` — update the existing physics import:

```js
import { syncPhysicsBodyFromObject, setPhysicsBodyTrigger, physicsAggregates } from "./physics.js";
```

And add after the `object.hits` reset block (after line 74):

```js
    if (object.hitStage !== undefined) {
      object.hitStage = 0;
    }
```

- [ ] **Step 4: Start server and verify no import errors**

Run: `npm run dev`

Expected: Server starts without errors. Open browser, verify game still works. Fragmentation won't trigger yet until missiles collide with destructible blocks.

- [ ] **Step 5: Commit**

```bash
git add server/game/fragmentation.js server/game/modeRunner.js
git commit -m "feat: fragmentation system with shatter, lifecycle, and hook context"
```

---

### Task 8: Client — crack stage handling

**Files:**
- Modify: `public/client/level.js`
- Modify: `public/client/state.js`

- [ ] **Step 1: Add crack stage tracking maps and helper in `public/client/level.js`**

Add after the existing imports (after line 6):

```js
const crackStageVisuals = new Map();
const fragmentVisuals = new Map();
```

- [ ] **Step 2: Add `updateCrackStage` function in `public/client/level.js`**

Add after the `registerCloneShadows` function (after line 191):

```js
function findHitStageMesh(templatePath, hitStage) {
  const templateRoot = getTemplateRoot(templatePath);
  if (!templateRoot) return null;

  const stageName = `hit${hitStage}-Visual`;
  const descendants = descendantsOf(templateRoot);
  return descendants.find((d) => d.name.includes(stageName)) ?? null;
}

export function updateCrackStage(objectId, hitStage, fragmentTemplate) {
  const visual = visualObjects.get(objectId);
  if (!visual || !fragmentTemplate) return;

  const prev = crackStageVisuals.get(objectId);
  if (prev) {
    prev.dispose(false, false);
    crackStageVisuals.delete(objectId);
  }

  if (!hitStage || hitStage <= 0) {
    const descendants = descendantsOf(visual);
    for (const node of descendants) {
      const role = childRole(node.name);
      if (role === "Vis" || role === "ColVis") {
        if (node.setEnabled) node.setEnabled(true);
      }
    }
    return;
  }

  const descendants = descendantsOf(visual);
  for (const node of descendants) {
    const role = childRole(node.name);
    if (role === "Vis" || role === "ColVis") {
      if (node.setEnabled) node.setEnabled(false);
    }
  }

  const sourceMesh = findHitStageMesh(fragmentTemplate, hitStage);
  if (!sourceMesh) return;

  const clone = sourceMesh.clone(`${objectId}-crack-${hitStage}`);
  clone.parent = visual;
  clone.position.set(0, 0, 0);
  clone.setEnabled(true);
  registerCloneShadows(clone);
  crackStageVisuals.set(objectId, clone);
}
```

- [ ] **Step 3: Update `clearLevel` to clean up crack stages and fragments**

In the `clearLevel` function, add after `visualObjects.clear()`:

```js
  for (const visual of crackStageVisuals.values()) {
    visual.dispose(false, false);
  }
  crackStageVisuals.clear();

  for (const visual of fragmentVisuals.values()) {
    visual.dispose(false, false);
  }
  fragmentVisuals.clear();
```

- [ ] **Step 4: Update `applyState` in `public/client/state.js` to handle hitStage**

Add import at the top of `public/client/state.js` (after line 2):

```js
import { updateCrackStage } from "./level.js";
```

In the `applyState` function, after the closing `}` of the arm angle `if` block (line 52), and before the closing `}` of the for-loop body (line 53), add:

```js
    if (object.hitStage !== undefined && object.hitStage > 0) {
      const prev = latestObjectStates.get(object.id);
      if (!prev || prev.hitStage !== object.hitStage) {
        updateCrackStage(object.id, object.hitStage, object.fragmentTemplate);
      }
    }
```

This must be at the same indentation level as the arm angle `if` block — NOT nested inside it. The block structure should be:

```js
    // existing arm angle block (lines 48-52):
    const arm = trebuchetArmNodes.get(object.id);
    if (arm && typeof object.armAngle === "number") {
      arm.rotationQuaternion = null;
      arm.rotation.z = degreesToRadians(object.armAngle);
      arm.computeWorldMatrix(true);
    }
    // NEW hitStage block — same level:
    if (object.hitStage !== undefined && object.hitStage > 0) {
      ...
    }
  }  // end of for-loop body
```

- [ ] **Step 5: Commit**

```bash
git add public/client/level.js public/client/state.js
git commit -m "feat: client crack stage visual swapping"
```

---

### Task 9: Client — fragment visuals and shrink animation

**Files:**
- Modify: `public/client/level.js`
- Modify: `public/client/network.js`

- [ ] **Step 1: Add fragment visual creation helper in `public/client/level.js`**

Add after the `updateCrackStage` function:

```js
function findFragMesh(templatePath, pieceIndex) {
  const templateRoot = getTemplateRoot(templatePath);
  if (!templateRoot) return null;

  const suffix = String(pieceIndex + 1).padStart(3, "0");
  const descendants = descendantsOf(templateRoot);
  return descendants.find((d) => d.name.includes(`Frag.${suffix}`)) ?? null;
}

export function createFragmentVisual(fragId, pieceIndex, fragmentTemplate) {
  if (fragmentVisuals.has(fragId)) return;

  const sourceMesh = findFragMesh(fragmentTemplate, pieceIndex);
  if (!sourceMesh) return;

  const clone = sourceMesh.clone(fragId);
  clone.parent = null;
  clone.setEnabled(true);
  registerCloneShadows(clone);
  fragmentVisuals.set(fragId, clone);
  visualObjects.set(fragId, clone);
  visualBaseRotations.set(fragId, { x: 0, y: 0, z: 0 });
}

export function hideBlockVisual(blockId) {
  const visual = visualObjects.get(blockId);
  if (visual) visual.setEnabled(false);

  const crack = crackStageVisuals.get(blockId);
  if (crack) {
    crack.dispose(false, false);
    crackStageVisuals.delete(blockId);
  }
}

export function shrinkAndDisposeFragment(fragId) {
  const visual = fragmentVisuals.get(fragId);
  if (!visual) return;

  const shrinkMs = (window.BARRAGE_CONFIG?.fragmentShrinkMs ?? 500);
  const startTime = performance.now();
  const startScale = visual.scaling?.clone() ?? new BABYLON.Vector3(1, 1, 1);

  const observer = scene.onBeforeRenderObservable.add(() => {
    const elapsed = performance.now() - startTime;
    const t = Math.min(elapsed / shrinkMs, 1);
    const s = 1 - t;
    visual.scaling.set(startScale.x * s, startScale.y * s, startScale.z * s);

    if (t >= 1) {
      scene.onBeforeRenderObservable.remove(observer);
      visual.dispose(false, false);
      fragmentVisuals.delete(fragId);
      visualObjects.delete(fragId);
      visualBaseRotations.delete(fragId);
    }
  });
}
```

- [ ] **Step 2: Update `ensureVisualsForState` to handle fragment objects and hide Frag/hitStage nodes**

In `ensureVisualsForState` (line 193), add a check at the beginning of the loop body, after `if (visualObjects.has(obj.id)) continue;`:

```js
    if (obj.isFragment) {
      createFragmentVisual(obj.id, obj.pieceIndex, obj.fragmentTemplate);
      continue;
    }
```

Also update the existing descendant-hiding loop inside `ensureVisualsForState` (the block that disables `"Col"` nodes). Change it to also hide `hit{N}-Visual` nodes on block clones. Frag nodes are NOT hidden — they compose the intact block visual:

```js
    const descendants = descendantsOf(clone);
    for (const node of descendants) {
      const role = childRole(node.name);
      if (role === "Col" && node.setEnabled) {
        node.setEnabled(false);
      }
      if (/hit\d+-Visual/.test(node.name) && node.setEnabled) {
        node.setEnabled(false);
      }
    }
```

This replaces the existing descendant loop (lines 212–217 in the current `level.js`). Without the `hit{N}-Visual` hiding, spawning a fragmented block template directly (e.g., `blocks/fragmented-L`) would show all crack stage overlays simultaneously.

- [ ] **Step 3: Handle events in `public/client/network.js`**

Add import after the existing imports (line 3):

```js
import { hideBlockVisual, shrinkAndDisposeFragment } from "./level.js";
```

In the `socket.addEventListener("message", ...)` handler, add after the `matchReset` handler (after line 132) and before the `state` handler:

```js
  if (message.type === "event") {
    for (const evt of message.events ?? []) {
      if (evt.kind === "blockBroken") {
        hideBlockVisual(evt.blockId);
      }
      if (evt.kind === "fragmentRemoving") {
        shrinkAndDisposeFragment(evt.fragId);
      }
    }
  }
```

The `blockBroken` event hides the block. Fragment visuals are created by `ensureVisualsForState` on the next state update — the fragment objects include `isFragment`, `pieceIndex`, and `fragmentTemplate` in the wire format, so the client has all it needs.

- [ ] **Step 4: Start server and test the full flow in browser**

Run: `npm run dev`

Open browser at `http://localhost:3000`. Test the following:

1. **Verify basic game works** — drag blocks, fire missiles, all objects visible
2. **Fire missile at a destructible block** (one with `fragmentTemplate`) — should see crack stages appear on hits, then block shatters into fragment pieces on final hit
3. **Fragment pieces fly outward** with physics, land on ground
4. **Fragments shrink and disappear** after `fragmentLifetimeMs`
5. **Check console** for any errors

If fragments don't appear visually: check that the `blockBroken` event is received (add `console.log` in the event handler) and that fragment objects appear in state updates with `isFragment`, `pieceIndex`, and `fragmentTemplate` fields.

If crack stages don't show: verify the fragment template GLB has nodes named `hit1-Visual`, `hit2-Visual`, etc. Check browser console for the `updateCrackStage` calls.

- [ ] **Step 5: Commit**

```bash
git add public/client/level.js public/client/network.js
git commit -m "feat: client fragment visuals, shrink animation, and blockBroken event handling"
```

---

### Task 10: Integration verification

- [ ] **Step 1: Verify full round-trip**

Run: `npm run dev`

Open two browser tabs at `http://localhost:3000` (player 1 and player 2).

Test checklist:
1. [ ] Blocks spawn with correct positions
2. [ ] Kings spawn with convex hull shapes (more accurate collision than boxes)
3. [ ] Missile fired at a destructible block → hit stages appear (cracks)
4. [ ] Final hit → block shatters, fragments fly outward
5. [ ] Fragments have physics (bounce off ground, walls, each other)
6. [ ] Fragments shrink and disappear after lifetime expires
7. [ ] Missile hitting a fragment → fragment starts shrinking, missile slows down
8. [ ] Round transition clears all fragments
9. [ ] Both players see the same effects
10. [ ] No console errors

- [ ] **Step 2: Verify late-joining client**

With the game running and fragments on screen, open a third browser tab. Verify:
- Active fragments appear correctly (from `isFragment`/`pieceIndex`/`fragmentTemplate` in state updates)
- Crack stages on blocks appear correctly (from `hitStage` in state updates)

- [ ] **Step 3: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: integration fixes for complex object detection"
```

---

## Notes

### Spec deviations

**No `createBodyWithShape` helper.** The spec defines a `createBodyWithShape()` that uses `PhysicsBody` directly with a pre-computed `PhysicsShape`. This plan uses `createConvexHullBody()` (which creates `PhysicsAggregate` from cached vertex positions) for both kings and fragment pieces instead. Reason: `PhysicsAggregate` manages shape lifecycle automatically, and per-fragment shapes avoid shared-shape issues when setting `isTrigger` for the shrink phase. The vertex extraction still happens at startup — only the hull computation happens at shatter time, which is sub-millisecond for typical fragment meshes (~200 vertices × 8 pieces).

**No `precomputedShape` in template cache.** Fragment entries cache `convexPositions: Float32Array` instead of `precomputedShape: PhysicsShape`. This follows from the above — shapes are created per-fragment at shatter time.

**No missile speed threshold for block hits.** The spec says "block reached maxHits with sufficient missile speed." This plan registers a hit on every `COLLISION_STARTED` event regardless of velocity. `COLLISION_STARTED` only fires on new contacts (not resting/sliding contacts), so low-energy bumps between already-touching objects don't trigger. A slow bounce could still register a hit, but this is acceptable — the missile had to travel to reach the block.

**No missile→king collision handler.** The spec lists missile→king in the collision dispatch table, but king knockouts already work via physics rotation (>45° = knockout). Collision callbacks are NOT enabled on king bodies. If king hit counting is needed later, enable callbacks and add a handler in `collisions.js`.

**No impact position for sound effects.** The spec mentions storing impact position for `missile_hits_fragment` sound. This plan omits it — add `event.point` capture to `handleMissileFragmentHit` when audio is implemented.

**`blockHit` event broadcast but not consumed.** The `blockHit` event is broadcast by the server for future use (sound effects, hit flash). The client currently drives crack stage visuals from `hitStage` in per-tick state updates, not from this event. Both arrive in the same tick; the state-driven approach handles late-joining clients automatically.

### Constraints

**Fragment GLB numbering must be consecutive.** Client-side `findFragMesh` looks up `Frag.{pieceIndex+1}` padded to 3 digits (e.g., pieceIndex 0 → `Frag.001`). If a GLB has gaps in numbering (e.g., `Frag.002` and `Frag.005` with no `Frag.001`), `detectFragments` assigns sequential pieceIndex values but the client lookup will find the wrong nodes. Current GLBs use consecutive numbering (`Frag.001` through `Frag.008`).

**Hit stage meshes must be invisible by default in GLB.** `ensureVisualsForState` hides `hit{N}-Visual` nodes on block clones, but if they're visible in the GLB there may be a single frame of overlap before the hiding runs. The Blender source should set hit stage meshes to invisible. Frag nodes are left visible — they compose the intact block visual and only separate when `blockBroken` fires.

### Manual steps (not automated)

**GLB renaming**: The spec requires renaming `ColVis.{N}` → `Frag.{N}` on fragment pieces in `fragmented-L.glb` and `fragmented-R.glb`. This is a Blender/GLB editing task, not a code change. Verify the GLB files have the correct naming before testing — `detectFragments()` looks for nodes matching `Frag.{N}`.

### Circular import

`collisions.js` ↔ `modeRunner.js` have a circular import (`collisions` imports `callHook`/`getHookContext`, `modeRunner` imports `clearCollisionState`). This works in Node.js ESM because both modules only access each other's exports at runtime (function calls), never during module evaluation.

### `aggregate.shape.isTrigger`

`PhysicsAggregate.shape` returns the `PhysicsShape` created by the aggregate. `PhysicsShape.isTrigger` is a documented Babylon.js v2 setter that calls the Havok plugin. Since each fragment has its own `PhysicsAggregate` (not sharing shapes), setting `isTrigger` on one fragment doesn't affect others. If this API doesn't work as expected at runtime, the fallback is to dispose the aggregate entirely and skip the trigger phase.
