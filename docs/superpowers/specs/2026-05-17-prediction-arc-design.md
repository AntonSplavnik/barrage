# Prediction Arc Design

## Overview

Add a visual trajectory prediction arc that shows the player where their shot will land while aiming a trebuchet. The server computes the full arc (32 points along the predicted flight path) and broadcasts it to the aiming player only. The client is a pure renderer — no physics math.

## Decisions

- **Server-authoritative arc**: server computes all 32 arc points, client only renders them. Single source of truth for shot physics.
- **Per-client filtering**: only the aiming player sees the arc. The opponent does not.
- **Dotted spheres**: 32 small spheres positioned along the curve (same visual style as rufus-prototype).
- **Power-based color**: dots go from dark/dim at low pull to bright white at full pull, based on `powerRatio`.
- **Fade on fire**: 1.5s fade-out animation after the trebuchet fires.

## Bombs

Bombs (`missileType: "bomb"`) can be loaded into trebuchets and aimed like regular missiles. The prediction arc works identically for bombs — it shows the projectile trajectory, not the explosion radius. The arc uses the same `missileLinearDamping` for all missile types. No special handling is needed; this is noted here so implementers don't add unnecessary branching.

## Server: Trajectory Math

New file: `server/game/trajectoryArc.js`

### API

```js
computeArcPoints({ startPoint, velocity, gravity, damping, dotCount, arcFraction, maxDuration, groundY })
→ [{ x, y, z }, ...]
```

### Physics Model

Projectile motion with linear air damping (exponential velocity decay under constant gravity). Ported from `rufus-prototype`'s `trebuche-shot-arc-prediction.js`.

All functions early-return safe defaults (zero-length array or `0`) when inputs contain NaN or when `startPoint` / `velocity` is null/undefined.

**`dampedPosition(startPoint, velocity, gravity, damping, t)`** — returns `{x, y, z}` at time `t`:

- If damping ≈ 0: standard kinematic `p = p0 + v*t + 0.5*g*t²`
- With damping: analytical solution using `decay = exp(-damping * t)`, scaling velocity and gravity contributions by damping integrals

**`dampedFlightDurationToGround(startPoint, velocity, gravity, damping, groundY, maxDuration)`** — finds when the projectile hits `groundY`:

- If damping ≈ 0: quadratic formula
- With damping: 1/60s step simulation, linear interpolation at ground crossing

**`computeArcPoints()`** — computes `dotCount` evenly-spaced-in-time positions from `t=0` to `t = flightDuration * arcFraction`, capped at `maxDuration`.

### Config Values Used

From `SERVER_CONFIG`:

| Key | Default | Purpose |
|-----|---------|---------|
| `gravity` | -9.81 | Gravitational acceleration |
| `missileLinearDamping` | 0.15 | Air resistance on missiles |
| `shotArcDotCount` | 32 | Number of arc points |
| `shotArcFraction` | 0.67 | Fraction of flight path to draw |
| `shotArcMaxDuration` | 4 | Max arc duration in seconds |
| `shotArcGroundY` | 0 | Ground plane Y |

`missileLinearDamping` is a new config key. Currently missiles use a hardcoded `0.15` in `physics.js` lines 192 and 258. This spec replaces those with the config value.

## Server: Aim State Computation

### `updateTrebuchetAim()` in `server/game/trebuchet.js`

After computing `aimCurrent` and `armAngle` (existing logic), add:

1. Compute `shotVelocity` using the same formula as `beginTrebuchetRelease()` — call `releaseVelocityForObject` (not `clampVector` directly) so the arc stays coupled to the actual fire path:
   ```
   velocity = releaseVelocityForObject({ id: "missile" }, {
     x: |aimStart.x - aimCurrent.x| * powerScale * shotDirectionX,
     y: (aimStart.y - aimCurrent.y) * powerScale,
     z: (aimStart.z - aimCurrent.z) * powerScale,
   }, trebuchetFireVelocityMax())
   ```

2. Compute `shotStartPoint` at the **rest arm angle** (not the current pulled-back angle). The actual missile releases when the arm swings forward to the rest position, so the arc must start from that point to predict the real landing spot:
   ```
   const prevAngle = trebuchet.armAngle;
   trebuchet.armAngle = restArmAngleForTrebuchet();
   const shotStartPoint = loadTargetForTrebuchet(trebuchet);
   trebuchet.armAngle = prevAngle;
   loadTargetForTrebuchet(trebuchet); // restore internal node transforms
   ```
   If `loadTargetForTrebuchet` returns `null`, skip arc computation entirely — set all arc fields to `null` and return.

3. Compute `shotArcPoints` via `computeArcPoints()` using the velocity, start point, gravity, and damping from config.

4. Compute `powerRatio` = velocity magnitude / `trebuchetFireVelocityMax`, clamped 0→1.

Store all four on the trebuchet object: `trebuchet.shotVelocity`, `trebuchet.shotStartPoint`, `trebuchet.shotArcPoints`, `trebuchet.powerRatio`.

### Clearing Aim State

Clear `shotVelocity`, `shotStartPoint`, `shotArcPoints`, and `powerRatio` (set to `null`) when:
- `beginTrebuchetRelease()` is called (aim ends, fire begins)
- `releaseLoadedMissileFromTrebuchet()` clears the other aim fields (`aimedBy`, `aimStart`, `aimCurrent`) — clear the arc fields alongside them
- Aim is cancelled (wrong direction pull, trebuchet reset)
- The trebuchet's `fireState` leaves `"aiming"`

### Disconnect Cleanup

If a client disconnects while aiming, the trebuchet stays in `fireState: "aiming"` with `aimedBy` pointing to a dead client — a pre-existing issue that the arc fields inherit. In the `socket.on("close")` handler in `server/net/connections.js` (line 35), add cleanup alongside the existing `releaseDragForClient` call: for every trebuchet where `trebuchet.aimedBy === disconnectedClientId`, reset `fireState` to `ARM_STATE_IDLE`, restore `armAngle` to `restArmAngleForTrebuchet()`, and clear `aimedBy`, `aimStart`, `aimCurrent`, `shotVelocity`, `shotStartPoint`, `shotArcPoints`, and `powerRatio`. Extract this as `releaseAimForClient(clientId)` in `trebuchet.js`, mirroring the pattern of `releaseDragForClient(clientId)` in `drag.js`.

## Server: Wire Protocol

### `toWireObject()` in `server/game/entities.js`

Add a second parameter: `toWireObject(object, clientId)`.

**Note**: `toWireObject` now includes a `missileType` field (added by the explosion system). Preserve that existing line when adding the arc fields.

For trebuchet objects, include `shotArcPoints` and `powerRatio` only when both conditions hold:
- `object.fireState === ARM_STATE_AIMING` (use the exported constant, not a string literal)
- `object.aimedBy === clientId`

This keeps the arc private to the aiming player.

### `sendState()` in `server/net/broadcast.js`

Currently sends the same payload to all clients. Change to per-client serialization:

```js
export function sendState() {
  const base = {
    type: "state",
    tick: gameState.tick,
    serverTime: Date.now(),
    roundNumber: gameState.roundNumber,
    scores: gameState.scores,
  };

  for (const client of clients.values()) {
    if (client.socket.readyState !== client.socket.OPEN) continue;
    const objects = [...gameObjects.values()].map(o => toWireObject(o, client.id));
    client.socket.send(JSON.stringify({ ...base, objects }));
  }
}
```

Per-client overhead: `toWireObject` only branches for trebuchets during aiming, but `JSON.stringify` is now called once per client instead of once total. For a 2-player game with ~20 objects, the extra stringify adds <0.1ms per tick — well within the 16.67ms budget.

### Bandwidth

Each point serializes as `{"x":-12.34,"y":5.67,"z":0.89}` (~34 bytes including JSON keys and structure). 32 points + array wrapper + `shotArcPoints` key + `powerRatio` ≈ **1.2KB** per aim tick, sent to one client only. At 60Hz that's ~72KB/s to the aiming client — manageable for any reasonable WebSocket connection, though it roughly doubles the state message size for that client. Normal (non-aiming) state messages are ~2–4KB.

## Client: Arc Renderer

New file: `public/client/shotArcRenderer.js`

### API

```js
createShotArcRenderer(scene, config)
→ { update(points, powerRatio), fadeOut(durationMs), hide(), dispose() }
```

### Mesh Setup

Create one base sphere mesh and register `config.shotArcDotCount - 1` (default 31) thin instances on it. Thin instances share geometry and material in a single draw call, reducing 32 draw calls to 1:
- Base sphere: diameter `config.shotArcDotSize` (default 0.14m), segments 8
- `isPickable: false`
- `renderingGroupId: 2` (renders in front)
- Initially disabled (base mesh + all thin instances)
- Update thin instance matrices per frame via `thinInstanceSetMatrixAt()` + `thinInstanceSetBuffer()`

Single shared `StandardMaterial` with `disableLighting: true`, `disableDepthWrite: true` (matches the aim arrow material — ensures dots are always visible and not occluded by the aim arrow, which shares renderingGroupId 2).

### `update(points, powerRatio)`

1. If no points or empty array → `hide()` and return
2. Cancel any active fade and reset material alpha to 1 (prevents partially-transparent dots if the player re-aims before a fade-out completes)
3. Build a `Float32Array` of 4×4 translation matrices, one per point, with Z offset by `config.shotArcZOffset` (default 0.08m). Set the thin instance count to `points.length` via `thinInstanceCount` and upload the buffer
4. Set material emissive color: lerp from dark gray `(0.15, 0.15, 0.15)` to white `(1, 1, 1)` based on `powerRatio`
5. Enable the base mesh (all thin instances render with it)

### `fadeOut(durationMs)`

Default 1500ms. Uses `scene.onBeforeRenderObservable`:
- Animate material alpha from 1→0
- On completion, call `hide()`

### `hide()`

Disable the base mesh (hides all thin instances), cancel any active fade, reset alpha to 1.

### `dispose()`

Dispose the base mesh (thin instances are cleaned up with it) and material.

## Client: Integration

### `aim.js`

Import the renderer. In `updateAimArrow()`:

After reading the trebuchet state from `latestObjectStates`, check for `shotArcPoints` and `powerRatio`:

```js
const trebuchetState = latestObjectStates.get(trebuchetId);
if (trebuchetState?.shotArcPoints) {
  shotArcRenderer.update(trebuchetState.shotArcPoints, trebuchetState.powerRatio ?? 0);
} else {
  shotArcRenderer.hide();
}
```

Add `shotArcRenderer.hide()` to all early-return paths in `updateAimArrow()` (same pattern as `hideAimArrow()`).

### `level.js`

- On level load: create the renderer via `createShotArcRenderer(scene, CONFIG)`
- On level dispose: call `renderer.dispose()`
- Export an accessor so `aim.js` can reach the renderer

**Note**: `level.js` now includes `removeStaleVisuals()` (added by the explosion system to clean up client visuals when objects like bombs are removed server-side). This function deletes entries from `latestObjectStates` for removed objects. The arc integration is safe: if a trebuchet's state is deleted, `latestObjectStates.get(trebuchetId)` returns `undefined`, and the `?.shotArcPoints` check in `aim.js` falls through to `hide()`. The `removeStaleVisuals` function and its export must be preserved.

### `state.js`

In `applyState()`, preserve `shotArcPoints` and `powerRatio` from the wire object on the state map (they arrive as part of the trebuchet's state object, no special handling needed — `latestObjectStates.set(object.id, object)` already stores the full wire object).

**Note**: In `network.js`, the state message handler now calls `removeStaleVisuals()` → `ensureVisualsForState()` → `applyState()` in that order. Arc data flows through `applyState` into `latestObjectStates`, which then triggers `onAimUpdate`. This ordering is correct — no changes needed.

### Fade-out on Fire

When the trebuchet transitions from `fireState: "aiming"` to `fireState: "releasing"`, the `shotArcPoints` will no longer be present in the wire object. In `aim.js`, detect this transition: if the renderer was showing an arc and the new state has no `shotArcPoints` but `fireState === "releasing"`, call `fadeOut()` instead of `hide()`.

## Client Config

Add to `public/client/clientConfig.js`:

```js
shotArcDotCount: 32,
shotArcDotSize: 0.14,
shotArcFadeMs: 1500,
shotArcZOffset: 0.08,
shotArcDimColor: "#262626",
shotArcBrightColor: "#ffffff",
```

## Server Config

Add to `server/config.js` `SERVER_CONFIG`. Place `missileLinearDamping` in the existing `// Missiles` section (after `missileDamageMinSpeed`). Place `shotArc*` keys in a new `// Shot arc` section after `// Bombs`:

```js
// Missiles
missileDamageMinSpeed: 10,
missileLinearDamping: 0.15,

// Shot arc
shotArcDotCount: 32,
shotArcFraction: 0.67,
shotArcMaxDuration: 4,
shotArcGroundY: 0,
```

Add `missileLinearDamping` to `physics.js` to replace the two hardcoded `0.15` values on lines 192 and 258 with `getConfig("missileLinearDamping")`.

## File Summary

| File | Change |
|------|--------|
| `server/game/trajectoryArc.js` | **New** — pure arc math |
| `server/game/trebuchet.js` | Add arc computation to `updateTrebuchetAim()`, clear on release, new `releaseAimForClient()` |
| `server/game/entities.js` | `toWireObject(object, clientId)` — include arc for aiming player only |
| `server/net/broadcast.js` | Per-client serialization in `sendState()` |
| `server/net/connections.js` | Call `releaseAimForClient()` on disconnect |
| `server/config.js` | Add `missileLinearDamping`, `shotArc*` keys |
| `server/game/physics.js` | Use `getConfig("missileLinearDamping")` instead of hardcoded 0.15 |
| `public/client/shotArcRenderer.js` | **New** — dot renderer |
| `public/client/aim.js` | Wire renderer to aim state |
| `public/client/level.js` | Create/dispose renderer on level lifecycle |
| `public/client/clientConfig.js` | Add `shotArc*` visual config |
