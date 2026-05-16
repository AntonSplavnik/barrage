# Magnetic Drag System Migration

Migrate the drag system from `rufus-prototype` to `feat/server-refactor`, replacing direct-positioning drag for blocks/trebuchets with force-based magnetic drag while keeping direct positioning for missiles. Add server-side validation (zone + speed clamp) for all drag types.

## Current State (feat/server-refactor)

All draggable objects use the same logic:
- `handleDragMove` teleports the object to the client's pointer position each tick
- Physics body is synced and velocity zeroed during drag
- Object is lerped upright (`returnDraggedObjectUpright`)
- On release, velocity comes from client data with server fallback via `usableReleaseVelocity`

Files involved: `server/game/drag.js`, `server/game/simulation.js`, `server/game/entities.js`, `server/game/physics.js`, `server/game/state.js`, `server/config.js`.

## Target State

### Two drag modes

**Magnetic drag** for blocks and trebuchets:
- Server applies an attraction force toward the validated pointer position using Havok `applyForce()`
- Grab point stored in object-local coordinates — force applied at that point, producing natural rotation
- Damping force opposes velocity at the grab point to prevent oscillation
- Object is NOT teleported — it moves through physics
- On release, velocity comes from physics momentum (no client velocity needed)
- No `returnDraggedObjectUpright` — object rotates freely during magnetic drag

**Direct drag** for missiles (same as current, with additions):
- Server teleports missile to validated pointer position each tick
- Physics body set to trigger during drag (already implemented)
- On release, server computes velocity from `dragState` position history only — client velocity ignored
- Depenetration: if missile overlaps geometry on release, search for nearest clear position

### Server-side validation (both modes)

Applied in `handleDragMove` and `handleDragEnd` before any physics:

1. **Zone check** (already exists): reject/clamp positions outside the player's allowed half. Current thresholds: `x > 2` for player 1, `x < -2` for player 2. Trebuchets use `trebuchetLeftMinX/MaxX` and `trebuchetRightMinX/MaxX`.

2. **Speed clamp** (new): if the distance between the current `dragMove` position and the previous `dragState.lastPoint` exceeds `maxDragSpeed * dt`, clamp the position to the maximum allowed displacement along the same direction vector.

## Changes by File

### server/game/drag.js

**Add `usesMagneticDrag(object)`:**
Returns `true` for blocks and trebuchets, `false` for missiles, kings, fragments.

**Add `localPointForObject(object, point)`:**
Transforms a world-space grab point into the object's local coordinate frame using the physics body's world matrix inverse. Called once in `handleDragStart` to store `grabLocalPoint` in `dragState`.

**Add `applyMagneticDragForce(object)`:**
Called from `simulation.js` each physics tick for magnetically dragged objects.
```
grabWorldPoint = transform grabLocalPoint back to world using physics body world matrix
targetPoint = dragState.lastPoint (validated pointer position)
distance = ||targetPoint - grabWorldPoint||

if distance < 0.0001 or distance > dragRadiusLimit: return

forceMagnitude = dragForceMax * (1 - distance / dragRadiusLimit)
forceDirection = normalize(targetPoint - grabWorldPoint)
magneticForce = forceDirection * forceMagnitude

pointVelocity = linearVelocity + cross(angularVelocity, grabWorldPoint - centerOfMass)
dampingForce = -pointVelocity * dragDampingMax

totalForce = magneticForce + dampingForce
totalForce.z = 0  // zero Z component — constrainBodyToPlane will snap Z after the step anyway, so Z forces waste energy and cause micro-jitter
physicsBody.applyForce(totalForce, grabWorldPoint)
```

**Add `validateDragPosition(point, previousPoint, dt)`:**
Speed clamp logic. Returns the validated (possibly clamped) position.
```
displacement = point - previousPoint
distance = ||displacement||
maxDistance = maxDragSpeed * dt
if distance > maxDistance:
  return previousPoint + normalize(displacement) * maxDistance
return point
```

**Add `moveMissileReleaseTowardOriginUntilClear(object)`:**
Depenetration search on missile release. Check AABB overlap with all static/dynamic non-fragment objects. Search outward toward world origin in steps of `depenetrationStep` (0.25m), then upward, up to `depenetrationMaxDistance` (60m). If clear spot found, move missile there. If not, release at current position (physics will resolve).

**Modify `handleDragStart`:**
- Early return if `object.draggedBy` is already set — prevents a second player from stealing the drag and leaking the first player's `dragState` entry (never cleaned up since `handleDragEnd` won't fire for the original owner)
- After setting `dragState`, also store `grabLocalPoint` via `localPointForObject` if `usesMagneticDrag(object)` is true
- Remove `returnDraggedObjectUpright(object)` call for magnetic objects (they rotate freely)
- Keep upright lerp for missiles only

**Modify `handleDragMove`:**
- Add `validateDragPosition` call before `constrainedPointForObject`
- If `usesMagneticDrag(object)`: only update `dragState.lastPoint` and `lastTime`. Do NOT teleport the object, do NOT sync physics body, do NOT update dragVx/Vy/Vz. The physics force will move it.
- If missile: keep current behavior (teleport + sync), but use validated position

**Modify `handleDragEnd`:**
- If `usesMagneticDrag(object)`: clear dragState, set `draggedBy = null`. Don't set velocity — physics already has momentum. Don't teleport to release position.
- If missile: run depenetration, then release with server-computed velocity from `dragState` only (remove client velocity path from `usableReleaseVelocity`)

**Remove `usableReleaseVelocity` dual-source logic:**
Replace with `velocityFromDragState` only. Client velocity is no longer trusted.

### server/game/simulation.js

**Modify the pre-step `object.draggedBy` block:**
```
if (object.draggedBy) {
  if (usesMagneticDrag(object)) {
    applyMagneticDragForce(object);
  } else {
    // missile: keep current behavior
    returnDraggedObjectUpright(object);
    syncPhysicsBodyFromObject(object, { x: 0, y: 0, z: 0 });
  }
  continue;
}
```

**Modify the post-step readback skip:**
The current post-step loop has `if (object.draggedBy || object.loadedInto) continue;` which skips all dragged objects. This is correct for direct drag (the game object IS the source of truth) but wrong for magnetic drag (the physics body is the source of truth — forces moved it, and the game object hasn't been updated).

Change the skip condition:
```
if (object.loadedInto) continue;
if (object.draggedBy && !usesMagneticDrag(object)) continue;
```

Magnetically dragged objects now participate in the post-step readback: position, rotation, and velocity are read from the physics body back into the game object, same as any free-flying object. Without this, forces apply and the physics body moves, but `object.x/y/rot` never update and the client never sees movement.
```

### server/game/entities.js

No new functions needed — `usesMagneticDrag` lives in `drag.js` since it's drag-specific. Existing helpers (`isBlockName`, `isTrebuchetName`, `isMissileName`, `isFragmentName`) are sufficient.

### server/game/state.js

No changes. `dragState` map already exists. The entries will carry an additional `grabLocalPoint` field for magnetic objects — no schema change needed.

### server/config.js

Add to `SERVER_CONFIG`:
```javascript
// Magnetic drag physics.
dragForceMax: 1500,
dragRadiusLimit: 30,
dragDampingMax: 400,

// Server-side drag validation.
maxDragSpeed: 80,

// Missile release depenetration.
depenetrationStep: 0.25,
depenetrationMaxDistance: 60,
missileReleaseFloorPadding: 0.05,
```

These keys are server-only — no need to add them to `CLIENT_RELEVANT_KEYS`. All drag code reads config via `getConfig(key)` so levels can override values like `dragForceMax` if needed.

### server/game/physics.js

No new exports needed. `applyMagneticDragForce` will access the physics aggregate via the existing `physicsAggregates` map (imported from physics.js). Havok bodies already support `applyForce(force, worldPoint)` — confirm this is available on the aggregate's body, or use the lower-level Havok plugin API if needed.

## Edge cases

### Block-block collision during magnetic drag

With direct positioning blocks teleport through everything. With magnetic drag, blocks move through physics and will collide with other blocks mid-drag. The collision callbacks are active (`physics.js`).

Rules:
- A magnetically dragged block does NOT deal or receive fragmentation damage during drag. The collision system should skip pairs where either object has `draggedBy` set.
- This prevents jitter from the attraction force pushing a block persistently into another block (Havok resolves penetration each step while the force re-creates it). Without this, a player could weaponize dragging by ramming blocks into the opponent's structure.
- On release, normal collision rules resume immediately.

Implementation: add a guard at the top of the collision callback — if either collider's game object has `draggedBy` set, return early.

### Player disconnect while dragging

If a player disconnects mid-drag, `draggedBy` and `dragState` must be cleaned up or the object stays in a phantom-drag state with forces applied toward a stale pointer position.

The disconnect handler must call `releaseDragForClient(clientId)` — a new helper that iterates `gameObjects`, finds any object where `draggedBy === clientId`, clears `draggedBy`, deletes the `dragState` entry, and (for missiles) restores the physics body from trigger to solid. The object then falls under normal physics with whatever velocity the physics body had at disconnect. No release velocity calculation needed — momentum is already there for magnetic objects, and for missiles the velocity was zeroed during drag so it just drops.

## What does NOT change

- Client input: still sends `dragStart`, `dragMove`, `dragEnd` with world positions
- Client-side picking/raycasting logic
- Trebuchet aiming system (`aimStart`, `aimMove`, `aimRelease`) — separate from drag
- Zone enforcement thresholds
- Missile loading into trebuchets (`maybeLoadMissile`)
- Fragment handling (fragments are not draggable)

## Config values source

The magnetic drag config values (`dragForceMax: 1500`, `dragRadiusLimit: 30`, `dragDampingMax: 400`) come from `rufus-prototype`. These may need tuning since the server-refactor branch has different physics settings (e.g., `physicsTimeScale: 1.5` vs rufus-prototype's value). Start with rufus values and tune from there.

The `maxDragSpeed: 80` is new — set high enough to never trigger during normal play (a fast swipe across a 60-unit-wide field in one 16ms tick = ~3750 units/sec, so 80 m/s per tick is generous). This catches only blatant cheats.

All new config keys live in `SERVER_CONFIG` inside `server/config.js` and are read via `getConfig(key)`, consistent with the config separation done on this branch. `public/config.js` no longer exists.
