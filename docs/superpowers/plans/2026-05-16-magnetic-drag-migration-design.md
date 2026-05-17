# Magnetic Drag Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace direct-positioning drag for blocks/trebuchets with force-based magnetic drag, keep direct positioning for missiles, add server-side speed validation for all drag types, and clean up dead client code.

**Architecture:** Two drag modes coexist in `drag.js` — `usesMagneticDrag(object)` routes blocks/trebuchets through force-based physics (`applyForce` each tick in `simulation.js`), while missiles keep the existing teleport-and-sync path. Server owns all velocity computation; client release velocity sampling is removed entirely.

**Tech Stack:** Babylon.js Physics V2 (Havok), Node.js server, vanilla JS client.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `server/config.js` | Modify | Add magnetic drag, speed validation, and depenetration config values; remove `normalReleaseVelocityMax` from `CLIENT_RELEVANT_KEYS` |
| `server/game/drag.js` | Modify | Add `usesMagneticDrag`, `localPointForObject`, `validateDragPosition`, `applyMagneticDragForce`, `moveMissileReleaseUntilClear`, `releaseDragForClient`; rewrite all three handlers; remove `usableReleaseVelocity` |
| `server/game/simulation.js` | Modify | Pre-step: route magnetic objects to force application instead of sync; Post-step: allow magnetic objects to participate in readback |
| `server/net/connections.js` | Modify | Call `releaseDragForClient` on disconnect before deleting client |
| `public/client/input.js` | Modify | Remove release velocity sampling functions and state; simplify `dragEnd` message; remove blur listener body |
| `public/client/clientConfig.js` | Modify | Remove dead `releaseVelocity*` config keys |

---

### Task 1: Add magnetic drag config values

**Files:**
- Modify: `server/config.js:1-79`

- [ ] **Step 1: Add config keys to SERVER_CONFIG**

Add these keys after the existing `dragUprightLerp: 0.25` line (line 41) in `SERVER_CONFIG`:

```javascript
  // Magnetic drag
  dragForceMax: 1500,
  dragRadiusLimit: 30,
  dragDampingMax: 400,

  // Drag speed validation
  maxDragSpeed: 5000,

  // Missile release depenetration
  depenetrationStep: 0.25,
  depenetrationMaxDistance: 60,
  missileReleaseFloorPadding: 0.05,
```

- [ ] **Step 2: Remove `normalReleaseVelocityMax` from CLIENT_RELEVANT_KEYS**

Change `CLIENT_RELEVANT_KEYS` (line 66) from:

```javascript
const CLIENT_RELEVANT_KEYS = [
  "trebuchetArmRestRotationZDegrees",
  "normalReleaseVelocityMax",
  "aimMaxPullDistance",
  "fragmentShrinkMs",
];
```

to:

```javascript
const CLIENT_RELEVANT_KEYS = [
  "trebuchetArmRestRotationZDegrees",
  "aimMaxPullDistance",
  "fragmentShrinkMs",
];
```

- [ ] **Step 3: Verify server starts**

Run: `node server/index.js`
Expected: Server starts without errors. Kill with Ctrl+C.

- [ ] **Step 4: Commit**

```bash
git add server/config.js
git commit -m "feat: add magnetic drag config values, remove normalReleaseVelocityMax from client keys"
```

---

### Task 2: Add helper functions to drag.js

**Files:**
- Modify: `server/game/drag.js:1-121`

- [ ] **Step 1: Replace the entire import block**

Replace all imports at the top of `drag.js` (lines 1-17) with the following. This adds two new imports (`Vector3` from Babylon, `TICK_MS`/`getConfig` from config), adds `physicsAggregates` to the existing `./physics.js` import, and adds `isBlockName`/`isFragmentName` to the existing `./entities.js` import:

```javascript
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { gameObjects, dragState } from "./state.js";
import {
  isTrebuchetName,
  isMissileName,
  isKingName,
  isBlockName,
  isFragmentName,
  constrainWorldBounds,
  constrainedPointForObject,
  normalReleaseVelocityMax,
  releaseVelocityForObject,
} from "./entities.js";
import { clampVector } from "../math.js";
import { TICK_MS, getConfig } from "../config.js";
import {
  physicsAggregates,
  syncPhysicsBodyFromObject,
  setPhysicsBodyTrigger,
  returnDraggedObjectUpright,
} from "./physics.js";
import { maybeLoadMissile } from "./trebuchet.js";
```

- [ ] **Step 2: Add `usesMagneticDrag` function**

Add after the import block, before `velocityFromDragState`:

```javascript
export function usesMagneticDrag(object) {
  if (isFragmentName(object.id)) return false;
  return isBlockName(object.id) || isTrebuchetName(object.id);
}
```

- [ ] **Step 3: Add `localPointForObject` function**

Add after `usesMagneticDrag`:

```javascript
function localPointForObject(object, point) {
  const aggregate = physicsAggregates.get(object.id);
  if (!aggregate) return { x: 0, y: 0, z: 0 };

  const node = aggregate.transformNode;
  node.computeWorldMatrix(true);
  const inverse = node.getWorldMatrix().clone().invert();
  const local = Vector3.TransformCoordinates(
    new Vector3(Number(point.x), Number(point.y ?? object.y), Number(point.z)),
    inverse,
  );
  return { x: local.x, y: local.y, z: local.z };
}
```

- [ ] **Step 4: Add `validateDragPosition` function**

Add after `localPointForObject`:

```javascript
function validateDragPosition(point, previousPoint, dt) {
  const cappedDt = Math.min(dt, 2 * TICK_MS / 1000);
  const dx = Number(point.x) - Number(previousPoint.x);
  const dy = Number(point.y ?? previousPoint.y) - Number(previousPoint.y);
  const dz = Number(point.z) - Number(previousPoint.z);
  const distance = Math.hypot(dx, dy, dz);
  const maxDistance = getConfig("maxDragSpeed") * cappedDt;

  if (distance <= maxDistance) {
    return {
      x: Number(point.x),
      y: Number(point.y ?? previousPoint.y),
      z: Number(point.z),
    };
  }

  const scale = maxDistance / distance;
  return {
    x: Number(previousPoint.x) + dx * scale,
    y: Number(previousPoint.y) + dy * scale,
    z: Number(previousPoint.z) + dz * scale,
  };
}
```

- [ ] **Step 5: Verify server starts**

Run: `node server/index.js`
Expected: Server starts without errors (new functions exist but aren't called yet). Kill with Ctrl+C.

- [ ] **Step 6: Commit**

```bash
git add server/game/drag.js
git commit -m "feat: add usesMagneticDrag, localPointForObject, validateDragPosition helpers"
```

---

### Task 3: Add `applyMagneticDragForce`

**Files:**
- Modify: `server/game/drag.js`

- [ ] **Step 1: Add `applyMagneticDragForce` function**

Add after `validateDragPosition`:

```javascript
export function applyMagneticDragForce(object) {
  const aggregate = physicsAggregates.get(object.id);
  if (!aggregate) return;

  const state = dragState.get(object.id);
  if (!state?.grabLocalPoint || !state.lastPoint) return;

  const node = aggregate.transformNode;
  node.computeWorldMatrix(true);

  const grabWorldPoint = Vector3.TransformCoordinates(
    new Vector3(state.grabLocalPoint.x, state.grabLocalPoint.y, state.grabLocalPoint.z),
    node.getWorldMatrix(),
  );

  const targetPoint = new Vector3(
    Number(state.lastPoint.x),
    Number(state.lastPoint.y),
    Number(state.lastPoint.z),
  );

  const displacement = targetPoint.subtract(grabWorldPoint);
  const distance = displacement.length();
  if (distance < 0.0001 || distance > getConfig("dragRadiusLimit")) return;

  const forceDirection = displacement.normalize();
  const magneticForce = forceDirection.scale(getConfig("dragForceMax"));

  const linearVelocity = aggregate.body.getLinearVelocity();
  const angularVelocity = aggregate.body.getAngularVelocity();
  const centerOfMass = node.position.add(
    new Vector3(object.offsetX ?? 0, object.offsetY ?? 0, object.offsetZ ?? 0),
  );
  const r = grabWorldPoint.subtract(centerOfMass);
  const pointVelocity = linearVelocity.add(Vector3.Cross(angularVelocity, r));
  const dampingForce = pointVelocity.scale(-getConfig("dragDampingMax"));

  const totalForce = magneticForce.add(dampingForce);
  totalForce.z = 0;
  if (isTrebuchetName(object.id)) totalForce.y = 0;

  aggregate.body.applyForce(totalForce, grabWorldPoint);
}
```

- [ ] **Step 2: Verify server starts**

Run: `node server/index.js`
Expected: Server starts without errors. Kill with Ctrl+C.

- [ ] **Step 3: Commit**

```bash
git add server/game/drag.js
git commit -m "feat: add applyMagneticDragForce — attraction + damping at grab point"
```

---

### Task 4: Add `moveMissileReleaseUntilClear` and `releaseDragForClient`

**Files:**
- Modify: `server/game/drag.js`

- [ ] **Step 1: Add `moveMissileReleaseUntilClear` function**

Add after `applyMagneticDragForce`:

```javascript
function moveMissileReleaseUntilClear(object, clientId) {
  const step = getConfig("depenetrationStep");
  const maxDist = getConfig("depenetrationMaxDistance");

  function overlapsAny(x, y, z) {
    for (const other of gameObjects.values()) {
      if (other.id === object.id) continue;
      if (isFragmentName(other.id)) continue;
      if (!physicsAggregates.has(other.id)) continue;

      const dx = Math.abs(x - other.x) - (object.halfX + other.halfX);
      const dy = Math.abs(y - other.y) - (object.halfY + other.halfY);
      const dz = Math.abs(z - other.z) - (object.halfZ + other.halfZ);
      if (dx < 0 && dy < 0 && dz < 0) return true;
    }
    return false;
  }

  if (!overlapsAny(object.x, object.y, object.z)) return;

  for (let d = step; d <= maxDist; d += step) {
    if (!overlapsAny(object.x, object.y + d, object.z)) {
      object.y += d;
      return;
    }
  }

  const xDir = clientId === 1 ? -1 : 1;
  for (let d = step; d <= maxDist; d += step) {
    if (!overlapsAny(object.x + d * xDir, object.y, object.z)) {
      object.x += d * xDir;
      return;
    }
  }
}
```

- [ ] **Step 2: Add `releaseDragForClient` function**

Add after `moveMissileReleaseUntilClear`:

```javascript
export function releaseDragForClient(clientId) {
  for (const object of gameObjects.values()) {
    if (object.draggedBy !== clientId) continue;

    const state = dragState.get(object.id);

    if (usesMagneticDrag(object) && state?.originalAngularDamping !== undefined) {
      const aggregate = physicsAggregates.get(object.id);
      if (aggregate) {
        aggregate.body.setAngularDamping(state.originalAngularDamping);
      }
    }

    if (isMissileName(object.id)) {
      setPhysicsBodyTrigger(object, false);
    }

    object.dragVx = 0;
    object.dragVy = 0;
    object.dragVz = 0;
    object.draggedBy = null;
    dragState.delete(object.id);
  }
}
```

Note: `object.vx/vy/vz` are intentionally NOT set here. For magnetic objects, the physics body retains its momentum from force integration. Once `draggedBy` is cleared, the next `simulatePhysics()` post-step readback (enabled by Task 8's skip condition change) syncs the physics body's velocity back into `object.vx/vy/vz`. For missiles, velocity was zeroed during drag and will stay zero — the missile drops under gravity. Do not add velocity zeroing here.

- [ ] **Step 3: Verify server starts**

Run: `node server/index.js`
Expected: Server starts without errors. Kill with Ctrl+C.

- [ ] **Step 4: Commit**

```bash
git add server/game/drag.js
git commit -m "feat: add moveMissileReleaseUntilClear depenetration, releaseDragForClient cleanup"
```

---

### Task 5: Modify `handleDragStart`

**Files:**
- Modify: `server/game/drag.js:42-63`

- [ ] **Step 1: Rewrite handleDragStart**

Replace the entire `handleDragStart` function (lines 42-63) with:

```javascript
export function handleDragStart(client, message) {
  const object = gameObjects.get(message.entityId);
  if (!object || !message.point) return;
  if (!object.dynamic) return;
  if (object.loadedInto) return;
  if (isKingName(object.id)) return;
  if (object.draggedBy) return;

  if (isTrebuchetName(object.id)) {
    if (object.player && object.player !== client.id) return;
  } else {
    if (client.id === 1 && object.x > 2) return;
    if (client.id === 2 && object.x < -2) return;
  }

  object.draggedBy = client.id;
  object.vx = 0;
  object.vy = 0;
  object.vz = 0;

  if (usesMagneticDrag(object)) {
    const aggregate = physicsAggregates.get(object.id);
    if (aggregate) {
      aggregate.body.setLinearVelocity(Vector3.Zero());
      aggregate.body.setAngularVelocity(Vector3.Zero());
    }
    const grabLocalPoint = localPointForObject(object, message.point);
    const originalAngularDamping = aggregate?.body.getAngularDamping() ?? 0;
    if (aggregate) aggregate.body.setAngularDamping(0);
    dragState.set(object.id, {
      lastTime: Date.now(),
      lastPoint: message.point,
      grabLocalPoint,
      originalAngularDamping,
    });
  } else {
    if (isMissileName(object.id)) setPhysicsBodyTrigger(object, true);
    returnDraggedObjectUpright(object);
    dragState.set(object.id, { lastTime: Date.now(), lastPoint: message.point });
  }
}
```

Key changes from the original:
- Added `if (object.draggedBy) return;` — prevents drag stealing
- Magnetic path: zeros physics body velocity, stores `grabLocalPoint` and `originalAngularDamping`, sets angular damping to 0, does NOT call `returnDraggedObjectUpright`
- Missile path: same as before (trigger mode + upright lerp)

- [ ] **Step 2: Verify server starts**

Run: `node server/index.js`
Expected: Server starts without errors. Kill with Ctrl+C.

- [ ] **Step 3: Commit**

```bash
git add server/game/drag.js
git commit -m "feat: modify handleDragStart — steal guard, magnetic grab setup, angular damping zero"
```

---

### Task 6: Modify `handleDragMove`

**Files:**
- Modify: `server/game/drag.js:65-91` (line numbers from original file — these shift as earlier tasks add code)

- [ ] **Step 1: Rewrite handleDragMove**

Replace the entire `handleDragMove` function with:

```javascript
export function handleDragMove(client, message) {
  const object = gameObjects.get(message.entityId);
  if (!object || !message.point) return;
  if (object.draggedBy !== client.id) return;

  const now = Date.now();
  const previous = dragState.get(object.id);
  const dt = Math.max(0.001, (now - (previous?.lastTime ?? now)) / 1000);

  const validated = validateDragPosition(message.point, previous?.lastPoint ?? message.point, dt);
  const next = constrainedPointForObject(object, validated, client.id);

  if (usesMagneticDrag(object)) {
    dragState.set(object.id, {
      ...previous,
      lastTime: now,
      lastPoint: next,
    });
    return;
  }

  object.dragVx = (next.x - object.x) / dt;
  object.dragVy = (next.y - object.y) / dt;
  object.dragVz = (next.z - object.z) / dt;
  object.x = next.x;
  object.y = next.y;
  object.z = next.z;
  constrainWorldBounds(object);
  returnDraggedObjectUpright(object);
  syncPhysicsBodyFromObject(object, { x: 0, y: 0, z: 0 });
  object.vx = 0;
  object.vy = 0;
  object.vz = 0;
  dragState.set(object.id, { lastTime: now, lastPoint: next });
}
```

Key changes:
- Added `validateDragPosition` call before `constrainedPointForObject` — speed-clamps the pointer position
- Magnetic path: only updates `dragState.lastPoint` and `lastTime`, then returns. No teleport, no sync, no dragV update.
- Missile path: same as before but uses validated+constrained position

- [ ] **Step 2: Verify server starts**

Run: `node server/index.js`
Expected: Server starts without errors. Kill with Ctrl+C.

- [ ] **Step 3: Commit**

```bash
git add server/game/drag.js
git commit -m "feat: modify handleDragMove — speed validation, magnetic objects update target only"
```

---

### Task 7: Modify `handleDragEnd` and remove `usableReleaseVelocity`

**Files:**
- Modify: `server/game/drag.js`

- [ ] **Step 1: Delete `usableReleaseVelocity` function**

Remove the entire `usableReleaseVelocity` function (originally lines 31-40):

```javascript
function usableReleaseVelocity(object, message) {
  const clientVelocity = releaseVelocityForObject(object, message.velocity);
  const clientSpeed = Math.hypot(clientVelocity.x, clientVelocity.y, clientVelocity.z);

  if (clientSpeed > 0.1) {
    return clientVelocity;
  }

  return releaseVelocityForObject(object, velocityFromDragState(object, message.point));
}
```

- [ ] **Step 2: Rewrite handleDragEnd**

Replace the entire `handleDragEnd` function with:

```javascript
export function handleDragEnd(client, message) {
  const object = gameObjects.get(message.entityId);
  if (!object || !message.point) return;
  if (object.draggedBy !== client.id) return;

  const previous = dragState.get(object.id);
  const now = Date.now();
  const dt = Math.max(0.001, (now - (previous?.lastTime ?? now)) / 1000);
  const validated = validateDragPosition(message.point, previous?.lastPoint ?? message.point, dt);

  const rawVelocity = velocityFromDragState(object, validated);
  const releaseVelocity = releaseVelocityForObject(object, rawVelocity);

  if (usesMagneticDrag(object)) {
    const state = dragState.get(object.id);
    if (state?.originalAngularDamping !== undefined) {
      const aggregate = physicsAggregates.get(object.id);
      if (aggregate) {
        aggregate.body.setAngularDamping(state.originalAngularDamping);
        aggregate.body.setLinearVelocity(
          new Vector3(releaseVelocity.x, releaseVelocity.y, releaseVelocity.z),
        );
      }
    }
    object.vx = releaseVelocity.x;
    object.vy = releaseVelocity.y;
    object.vz = releaseVelocity.z;
    object.dragVx = 0;
    object.dragVy = 0;
    object.dragVz = 0;
    object.draggedBy = null;
    dragState.delete(object.id);
    return;
  }

  const next = constrainedPointForObject(object, validated, client.id);
  object.x = next.x;
  object.y = next.y;
  object.z = next.z;
  constrainWorldBounds(object);
  moveMissileReleaseUntilClear(object, client.id);

  if (!maybeLoadMissile(object)) {
    if (isMissileName(object.id)) setPhysicsBodyTrigger(object, false);
    object.vx = releaseVelocity.x;
    object.vy = releaseVelocity.y;
    object.vz = releaseVelocity.z;
    syncPhysicsBodyFromObject(object, releaseVelocity);
  } else {
    setPhysicsBodyTrigger(object, true);
    syncPhysicsBodyFromObject(object, { x: 0, y: 0, z: 0 });
  }
  object.dragVx = 0;
  object.dragVy = 0;
  object.dragVz = 0;
  object.draggedBy = null;
  dragState.delete(object.id);
}
```

Key changes:
- Added `validateDragPosition` at the top — applies speed clamp to both paths per spec
- Removed `usableReleaseVelocity` — all release velocity now from `velocityFromDragState` only (server-computed), using the validated point
- Magnetic path: restores angular damping, sets release velocity on physics body, does NOT teleport (physics body is at its correct position from force integration)
- Missile path: depenetration via `moveMissileReleaseUntilClear` before load check, removed `returnDraggedObjectUpright` call (not needed at release)

- [ ] **Step 3: Verify server starts**

Run: `node server/index.js`
Expected: Server starts without errors. Kill with Ctrl+C.

- [ ] **Step 4: Commit**

```bash
git add server/game/drag.js
git commit -m "feat: rewrite handleDragEnd — magnetic release via physics, missile depenetration, remove usableReleaseVelocity"
```

---

### Task 8: Modify simulation.js pre-step and post-step

**Files:**
- Modify: `server/game/simulation.js:1-86`

- [ ] **Step 1: Add imports**

Add `usesMagneticDrag` and `applyMagneticDragForce` to the import block. Add this import after the existing ones (e.g. after line 14):

```javascript
import { usesMagneticDrag, applyMagneticDragForce } from "./drag.js";
```

- [ ] **Step 2: Modify the pre-step `object.draggedBy` block**

Replace lines 38-42:

```javascript
    if (object.draggedBy) {
      returnDraggedObjectUpright(object);
      syncPhysicsBodyFromObject(object, { x: 0, y: 0, z: 0 });
      continue;
    }
```

with:

```javascript
    if (object.draggedBy) {
      if (usesMagneticDrag(object)) {
        applyMagneticDragForce(object);
      } else {
        returnDraggedObjectUpright(object);
        syncPhysicsBodyFromObject(object, { x: 0, y: 0, z: 0 });
      }
      continue;
    }
```

Magnetic objects get force applied instead of being teleported. Missiles keep the existing sync behavior.

- [ ] **Step 3: Modify the post-step readback skip**

Replace line 58:

```javascript
    if (object.draggedBy || object.loadedInto) continue;
```

with:

```javascript
    if (object.loadedInto) continue;
    if (object.draggedBy && !usesMagneticDrag(object)) continue;
```

Magnetically dragged objects now participate in post-step readback — forces move the physics body, and position/rotation/velocity must be read back into the game object for the client to see movement.

- [ ] **Step 4: Remove unused `returnDraggedObjectUpright` from simulation.js imports**

`returnDraggedObjectUpright` is still imported from `./physics.js` on line 8. It is still used in the missile pre-step path, so **keep the import**. (It was already imported in the original — no change needed here.)

Wait — check: is `returnDraggedObjectUpright` still called in the modified pre-step? Yes, in the `else` branch (missile path). Keep the import.

- [ ] **Step 5: Verify server starts**

Run: `node server/index.js`
Expected: Server starts without errors. Kill with Ctrl+C.

- [ ] **Step 6: Commit**

```bash
git add server/game/simulation.js
git commit -m "feat: route magnetic drag through force application in physics loop, allow post-step readback"
```

---

### Task 9: Add disconnect cleanup to connections.js

**Files:**
- Modify: `server/net/connections.js:1-40`

- [ ] **Step 1: Import `releaseDragForClient`**

Add this import after the existing imports (after line 5):

```javascript
import { releaseDragForClient } from "../game/drag.js";
```

- [ ] **Step 2: Add cleanup call in the close handler**

Replace lines 34-36:

```javascript
    socket.on("close", () => {
      clients.delete(clientId);
    });
```

with:

```javascript
    socket.on("close", () => {
      releaseDragForClient(clientId);
      clients.delete(clientId);
    });
```

If a player disconnects mid-drag, this restores angular damping for magnetic objects, disables trigger mode for missiles, clears `draggedBy` and `dragState`. The object then falls under normal physics with whatever velocity it had at disconnect.

- [ ] **Step 3: Verify server starts**

Run: `node server/index.js`
Expected: Server starts without errors. Kill with Ctrl+C.

- [ ] **Step 4: Commit**

```bash
git add server/net/connections.js
git commit -m "feat: release dragged objects on player disconnect"
```

---

### Task 10: Client cleanup — remove dead release velocity code

**Files:**
- Modify: `public/client/input.js:1-284`
- Modify: `public/client/clientConfig.js:1-39`

- [ ] **Step 1: Remove release velocity state variables from input.js**

Remove these four variable declarations (lines 13-16):

```javascript
let latestDragPoint = null;
let releaseSamples = [];
let releaseSampleTimer = null;
let releaseVelocity = { x: 0, y: 0, z: 0 };
```

- [ ] **Step 2: Remove release velocity functions from input.js**

Remove these four functions entirely:

`sampleReleasePoint` (lines 44-56):
```javascript
function sampleReleasePoint() {
  if (!latestDragPoint) return;

  releaseSamples.push({
    time: performance.now(),
    point: latestDragPoint,
  });

  const maxSamples = Math.max(2, (CONFIG.releaseVelocityFrameWindow ?? 5) + 1);
  while (releaseSamples.length > maxSamples) {
    releaseSamples.shift();
  }
}
```

`startReleaseVelocitySampling` (lines 58-65):
```javascript
function startReleaseVelocitySampling(point) {
  latestDragPoint = point;
  releaseSamples = [];
  sampleReleasePoint();

  const sampleHz = CONFIG.releaseVelocitySampleHz ?? 60;
  releaseSampleTimer = window.setInterval(sampleReleasePoint, 1000 / sampleHz);
}
```

`stopReleaseVelocitySampling` (lines 67-73):
```javascript
function stopReleaseVelocitySampling() {
  if (releaseSampleTimer) {
    window.clearInterval(releaseSampleTimer);
  }

  releaseSampleTimer = null;
}
```

`updateReleasePoint` (lines 75-77):
```javascript
function updateReleasePoint(point) {
  latestDragPoint = point;
}
```

`averageReleaseVelocity` (lines 79-98):
```javascript
function averageReleaseVelocity() {
  sampleReleasePoint();

  if (releaseSamples.length < 2) {
    return { x: 0, y: 0, z: 0 };
  }

  const frameWindow = CONFIG.releaseVelocityFrameWindow ?? 5;
  const samples = releaseSamples.slice(-Math.max(2, frameWindow + 1));
  const first = samples[0];
  const last = samples.at(-1);
  const dt = Math.max(0.001, (last.time - first.time) / 1000);
  const scale = CONFIG.releaseVelocityScale ?? 1.0;

  return clampMagnitude({
    x: ((last.point.x - first.point.x) / dt) * scale,
    y: ((last.point.y - first.point.y) / dt) * scale,
    z: ((last.point.z - first.point.z) / dt) * scale,
  }, getServerConfig("normalReleaseVelocityMax") ?? 8);
}
```

- [ ] **Step 3: Remove `clampMagnitude` and `getServerConfig` imports if now unused**

Check the import line (line 2):
```javascript
import { isDraggableRoot, clampMagnitude } from "./utils.js";
```

`clampMagnitude` was only used by `averageReleaseVelocity`. Remove it:
```javascript
import { isDraggableRoot } from "./utils.js";
```

Check the import (line 5):
```javascript
import { sendInput, getServerConfig } from "./network.js";
```

`getServerConfig` was only used by `averageReleaseVelocity`. Check if it's used elsewhere in the file — if not, remove it:
```javascript
import { sendInput } from "./network.js";
```

- [ ] **Step 4: Simplify `beginDrag` — remove release velocity sampling**

In `beginDrag` (around line 124), remove these two lines:

```javascript
  startReleaseVelocitySampling(point);
  releaseVelocity = { x: 0, y: 0, z: 0 };
```

The function becomes:

```javascript
function beginDrag() {
  const root = pickDraggableRoot();
  if (!root) return;

  selectedEntityId = root.name;
  pointerMode = "drag";
  dragDepth = root.getAbsolutePosition().z;

  const world = pointerWorldAtDragDepth() ?? root.getAbsolutePosition();
  const point = protocolPointFromWorld(world, selectedEntityId);

  const objectState = latestObjectStates.get(selectedEntityId);
  if (objectState?.loadedInto) {
    pointerMode = "aim";
    aimWorldPoint = world.clone();
    updateAimArrow();
    sendInput("aimStart", {
      entityId: selectedEntityId,
      trebuchetId: objectState.loadedInto,
      point,
    });
    return;
  }

  sendInput("dragStart", {
    entityId: selectedEntityId,
    point,
  });
}
```

- [ ] **Step 5: Simplify `moveDrag` — remove updateReleasePoint call**

In `moveDrag` (around line 156), remove the `updateReleasePoint(point);` call (line 178). The function becomes:

```javascript
function moveDrag() {
  if (!selectedEntityId) return;

  const world = pointerWorldAtDragDepth();
  if (!world) return;

  if (pointerMode === "aim") {
    aimWorldPoint = world.clone();
    updateAimArrow();
    const point = protocolPointFromWorld(world, selectedEntityId);
    sendInput("aimMove", {
      entityId: selectedEntityId,
      point,
    });
    return;
  }

  const point = protocolPointFromWorld(new Vector3(
    world.x,
    Math.max(world.y + (CONFIG.dragHeightOffset ?? 0.2), 0.2),
    world.z,
  ), selectedEntityId);

  sendInput("dragMove", {
    entityId: selectedEntityId,
    point,
  });
}
```

- [ ] **Step 6: Simplify `endDrag` — remove velocity computation, simplify message**

In `endDrag` (around line 186), replace the drag release section. The full function becomes:

```javascript
function endDrag() {
  if (!selectedEntityId) return;

  const world = pointerWorldAtDragDepth();
  const visual = visualObjects.get(selectedEntityId);
  const fallback = visual?.getAbsolutePosition() ?? Vector3.Zero();
  const point = world ?? fallback;

  if (pointerMode === "aim") {
    aimWorldPoint = point.clone();
    updateAimArrow();
    const finalPoint = protocolPointFromWorld(point, selectedEntityId);
    sendInput("aimRelease", {
      entityId: selectedEntityId,
      point: finalPoint,
    });

    selectedEntityId = null;
    pointerMode = "drag";
    aimWorldPoint = null;
    hideAimArrow();
    return;
  }

  const finalPoint = protocolPointFromWorld(new Vector3(
    point.x,
    Math.max(point.y + (CONFIG.dragHeightOffset ?? 0.2), 0.2),
    point.z,
  ), selectedEntityId);

  sendInput("dragEnd", {
    entityId: selectedEntityId,
    point: finalPoint,
  });

  selectedEntityId = null;
  pointerMode = "drag";
  aimWorldPoint = null;
  hideAimArrow();

  if (CONFIG.cameraControlsEnabled) {
    scene.activeCamera.attachControl(canvas, true);
  }
}
```

Key changes from original:
- Removed `updateReleasePoint(finalPoint);`
- Removed `releaseVelocity = averageReleaseVelocity();`
- Removed `stopReleaseVelocitySampling();`
- Removed `velocity: releaseVelocity` and `rot: 0` from the `dragEnd` message
- Removed `latestDragPoint = null;`, `releaseSamples = [];`, `releaseVelocity = { x: 0, y: 0, z: 0 };` cleanup

- [ ] **Step 7: Remove blur listener body**

Replace lines 281-283:

```javascript
  window.addEventListener("blur", () => {
    stopReleaseVelocitySampling();
  });
```

with nothing — remove the entire listener. The callback body is gone and the empty listener serves no purpose.

- [ ] **Step 8: Remove dead client config keys from clientConfig.js**

In `public/client/clientConfig.js`, remove these keys from `CLIENT_CONFIG` (lines 21-25):

```javascript
  releaseVelocityScale: 1.0,
  releaseVelocitySampleHz: 60,
  releaseVelocityFrameWindow: 5,
  releaseVelocityMinSampleDistance: 0.05,
```

Keep `dragHeightOffset: 0.2` and `missilePickColliderScale: 2` — those are still used.

The drag/release section becomes:

```javascript
  // Drag
  dragHeightOffset: 0.2,
  missilePickColliderScale: 2,
```

- [ ] **Step 9: Verify server starts and client loads**

Run: `node server/index.js`
Expected: Server starts. Open browser to the game URL. Page loads without console errors. Kill server with Ctrl+C.

- [ ] **Step 10: Commit**

```bash
git add public/client/input.js public/client/clientConfig.js
git commit -m "feat: remove client release velocity computation — server owns all velocity"
```
