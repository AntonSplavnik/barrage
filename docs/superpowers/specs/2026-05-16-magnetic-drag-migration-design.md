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
- On release, velocity is computed from `velocityFromDragState` (pointer movement history), clamped via `releaseVelocityForObject`, and set on the physics body
- No `returnDraggedObjectUpright` — object rotates freely during magnetic drag

**Direct drag** for missiles (same as current, with additions):
- Server teleports missile to validated pointer position each tick
- Physics body set to trigger during drag (already implemented)
- On release, server computes velocity from `dragState` position history only — client velocity ignored
- Depenetration: if missile overlaps geometry on release, search for nearest clear position

### Server-side validation (both modes)

Applied in `handleDragMove` and `handleDragEnd` before any physics:

1. **Zone check** (already exists): reject/clamp positions outside the player's allowed half. Current thresholds: `x > 2` for player 1, `x < -2` for player 2. Trebuchets use `trebuchetLeftMinX/MaxX` and `trebuchetRightMinX/MaxX`.

2. **Speed clamp** (new): if the distance between the current `dragMove` position and the previous `dragState.lastPoint` exceeds `maxDragSpeed * dt`, clamp the position to the maximum allowed displacement along the same direction vector. `maxDragSpeed` is in units/second (default 5000 — well above any legitimate swipe). `dt` is wall-clock seconds between messages, capped at `2 * TICK_MS / 1000` to prevent batching exploits (a cheater sending updates at 1/10th the rate would otherwise get 10x the allowed displacement per message).

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

forceDirection = normalize(targetPoint - grabWorldPoint)
magneticForce = forceDirection * dragForceMax

pointVelocity = linearVelocity + cross(angularVelocity, grabWorldPoint - centerOfMass)
dampingForce = -pointVelocity * dragDampingMax

totalForce = magneticForce + dampingForce
totalForce.z = 0  // constrainBodyToPlane snaps Z after the step — Z forces are wasted and cause micro-jitter
if (isTrebuchetName(object.id)) totalForce.y = 0  // constrainBodyToPlane also snaps trebuchet Y to originY and zeroes Y velocity — same issue
physicsBody.applyForce(totalForce, grabWorldPoint)
```

**Add `validateDragPosition(point, previousPoint, dt)`:**
Speed clamp logic. Returns the validated (possibly clamped) position.
```
dt = min(wallClockDtSeconds, 2 * TICK_MS / 1000)
displacement = point - previousPoint
distance = ||displacement||
maxDistance = maxDragSpeed * dt
if distance > maxDistance:
  return previousPoint + normalize(displacement) * maxDistance
return point
```

**Add `moveMissileReleaseUntilClear(object, clientId)`:**
Depenetration search on missile release. Check AABB overlap with all static/dynamic non-fragment objects. Search upward first (Y+) in steps of `depenetrationStep` (0.25m) up to `depenetrationMaxDistance` (60m) — the field is horizontal so up is always a clear escape. If upward fails, fall back to searching toward the player's half-field (X- for player 1, X+ for player 2). If neither finds a clear spot, release at current position (physics will resolve).

**Modify `handleDragStart`:**
- Early return if `object.draggedBy` is already set — prevents a second player from stealing the drag and leaking the first player's `dragState` entry (never cleaned up since `handleDragEnd` won't fire for the original owner)
- Zero `vx/vy/vz` (already done) — kept for magnetic drag so objects start from rest
- For magnetic objects: also zero the physics body's linear and angular velocity (`setLinearVelocity(Vector3.Zero())`, `setAngularVelocity(Vector3.Zero())`). Without this, the physics body retains pre-grab momentum — grabbing a falling block wouldn't stop it, just layer magnetic force on top of existing velocity.
- After setting `dragState`, also store `grabLocalPoint` via `localPointForObject` if `usesMagneticDrag(object)` is true
- For magnetic objects: store the body's current `angularDamping` in `dragState.originalAngularDamping`, then set it to 0. The spec's velocity-based damping at the grab point already handles damping; keeping the body-level value (0.55 for blocks, 10 for trebuchets) on top double-damps rotation and makes it feel sluggish.
- Remove `returnDraggedObjectUpright(object)` call for magnetic objects (they rotate freely)
- Keep upright lerp for missiles only

**Modify `handleDragMove`:**
- Add `validateDragPosition` call before `constrainedPointForObject`
- If `usesMagneticDrag(object)`: only update `dragState.lastPoint` and `lastTime`. Do NOT teleport the object, do NOT sync physics body, do NOT update dragVx/Vy/Vz. The physics force will move it.
- If missile: keep current behavior (teleport + sync), but use validated position

**Modify `handleDragEnd`:**
- For magnetic objects: restore body-level `angularDamping` from `dragState.originalAngularDamping`. Compute release velocity from `velocityFromDragState` (pointer movement, not physics body velocity), clamp via `releaseVelocityForObject` (which handles trebuchet X-only constraint), and set that velocity on the physics body. Clear dragState, set `draggedBy = null`. Don't teleport to release position — the physics body is already at its correct location from force integration.
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
maxDragSpeed: 5000,

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

With direct positioning blocks teleport through everything. With magnetic drag, blocks move through physics and will collide with other blocks mid-drag. However, no collision guard is needed:

- `collisions.js` already early-returns if neither body is a missile (`if (!missileA && !missileB) return;`), so block-block collisions never reach the damage logic.
- Dragged missiles are set to trigger mode (`setPhysicsBodyTrigger(object, true)` in `handleDragStart`), so they don't generate `COLLISION_STARTED` events at all.

Havok will still resolve block-block penetration during drag (pushing overlapping blocks apart), but this is the desired physical behavior — it prevents blocks from occupying the same space.

### Player disconnect while dragging

If a player disconnects mid-drag, `draggedBy` and `dragState` must be cleaned up or the object stays in a phantom-drag state with forces applied toward a stale pointer position.

The disconnect handler in `server/net/connections.js` must call `releaseDragForClient(clientId)` before `clients.delete(clientId)`. `releaseDragForClient` is a new helper (in `drag.js`) that iterates `gameObjects`, finds any object where `draggedBy === clientId`, restores `angularDamping` from `dragState.originalAngularDamping` (for magnetic objects), clears `draggedBy`, deletes the `dragState` entry, and (for missiles) restores the physics body from trigger to solid. The object then falls under normal physics with whatever velocity the physics body had at disconnect. No release velocity calculation needed — momentum is already there for magnetic objects, and for missiles the velocity was zeroed during drag so it just drops.

## Client changes

The client no longer computes release velocity — the server owns that entirely.

**Remove release velocity computation** (dead code after migration):
- `sampleReleasePoint`, `startReleaseVelocitySampling`, `stopReleaseVelocitySampling`, `updateReleasePoint`, `averageReleaseVelocity`
- Associated state: `releaseSamples`, `releaseSampleTimer`, `releaseVelocity`, `latestDragPoint`
- The `window.addEventListener("blur", () => { stopReleaseVelocitySampling(); })` listener — becomes an empty callback after removal

**Simplify `dragEnd` message format:**
```javascript
// Before:
sendInput("dragEnd", { entityId, point, velocity: releaseVelocity, rot: 0 });
// After:
sendInput("dragEnd", { entityId, point });
```
Server already ignores `rot` (computes rotation from physics) and now ignores `velocity` too.

**Remove `normalReleaseVelocityMax` from `CLIENT_RELEVANT_KEYS`** in `server/config.js`. It was only sent to the client for velocity clamping — no longer needed. Also removes a vector where a modified client could influence server behavior via crafted config.

**Keep (unchanged):**
- Object picking + screen-to-world (`pickDraggableRoot`, `pointerWorldAtDragDepth`)
- `dragHeightOffset` — Y offset applied before sending. UX convenience; server validates the result. Note: server-received Y values will be offset from the raw pointer position by this amount.
- `protocolPointFromWorld` — axis inversion for camera orientation
- `dragStart` and `dragMove` message format unchanged

## What does NOT change

- Trebuchet aiming system (`aimStart`, `aimMove`, `aimRelease`) — separate from drag
- Zone enforcement thresholds
- Missile loading into trebuchets (`maybeLoadMissile`)
- Fragment handling (fragments are not draggable)

## Config values source

The magnetic drag config values (`dragForceMax: 1500`, `dragRadiusLimit: 30`, `dragDampingMax: 400`) come from `rufus-prototype`. These may need tuning since the server-refactor branch has different physics settings (e.g., `physicsTimeScale: 1.5` vs rufus-prototype's value). Start with rufus values and tune from there.

The `maxDragSpeed: 5000` is in units/second — at 60Hz that's ~83 units per tick, above the ~60-unit field width, so it never triggers during normal play. Only catches blatant cheats (teleporting objects across the map). The dt cap at `2 * TICK_MS / 1000` prevents a cheater from batching slow updates to accumulate displacement.

All new config keys live in `SERVER_CONFIG` inside `server/config.js` and are read via `getConfig(key)`, consistent with the config separation done on this branch. `public/config.js` no longer exists.
