# VFX Particle System Design

## Overview

Client-side VFX particle effects system for Barrage. Provides explosion and missile-hit visual effects using Babylon.js ParticleSystem and custom mesh geometry, with a registry pattern for adding future effects.

Ported from the `rufus-prototype` branch and restructured for extensibility.

## Architecture

### File Structure

```
public/client/
  vfx/
    vfxManager.js       — effect registry, event routing, lifecycle tracking
    vfxConfig.js        — all VFX parameters grouped by effect
    textures.js         — procedural texture factories + shared material
    effects/
      explosion.js      — bomb detonation (fire + smoke + sparks + fragment burst)
      missileHit.js     — missile-on-block impact (tetrahedron fragment burst)
```

### Module Responsibilities

**`vfxManager.js`** — single entry point for the VFX system.
- Factory: `createVfxManager(scene)` → `{ handleEvent, clearEffects, dispose }`
- Maintains an effect registry: a plain object mapping event kind strings to effect instances
- Routes incoming events to the matching effect's `spawn()` method
- Tracks all active particle systems (`Set`) and mesh bursts (`Map`) for bulk cleanup
- `clearEffects()` — immediately disposes all active effects (called on round reset)
- `dispose()` — full teardown: calls `clearEffects()`, disposes shared textures/materials

**`textures.js`** — creates shared rendering resources once at init.
- Factory: `createSharedTextures(scene)` → `{ explosion, smoke, spark, fragmentMaterial, dispose() }`
- Three procedural DynamicTextures (see Shared Textures section)
- One StandardMaterial for fragment meshes
- Resources are passed to effects — effects never create their own textures

**`vfxConfig.js`** — exports `VFX_CONFIG` object with all tunable parameters.
- Grouped by effect name for clear ownership
- Each effect reads its own sub-config
- Values ported from rufus-prototype defaults

**Effect modules** (`effects/*.js`) — each exports a factory function:
- Signature: `createEffect(scene, sharedTextures, config, deps)` → `{ spawn(position, data), clear(), dispose() }`
- `spawn(position, data)` — creates the visual effect at the given world position
- `clear()` — immediately kills all active instances of this effect
- `dispose()` — releases any effect-specific resources (if any beyond shared textures)
- `deps` — optional object for cross-effect references (e.g., explosion receives `{ missileHit }` to delegate fragment bursts)
- Effects self-manage their Babylon.js resources (ParticleSystems, Meshes, observers)

### Adding a New Effect

1. Create `effects/newEffect.js` exporting `createNewEffect(scene, sharedTextures, config, deps)`
2. Add config params under `VFX_CONFIG.newEffect` in `vfxConfig.js`
3. Register in `vfxManager.js`: add entry to the effect map
4. Broadcast a corresponding event kind from the server (or reuse an existing one)

No other files need to change.

## Event System

### Trigger Model

VFX uses dedicated event kinds, decoupled from the SFX system. Sound and visuals are triggered independently by the server.

### Event Kinds Consumed

| Event Kind | Source | Data | Effect |
|------------|--------|------|--------|
| `"explosion"` | `server/game/explosion.js` (already exists) | `{ bombId, x, y, z, radius }` | Full explosion: fire + smoke + sparks + fragment burst |
| `"missileHit"` | `server/game/fragmentation.js` (new broadcast) | `{ x, y, z, speed }` | Tetrahedron fragment burst scaled by impact speed |

### Event Routing

In `vfxManager.js`:

```js
const effectMap = {
  "explosion": explosionEffect,
  "missileHit": missileHitEffect,
};

function handleEvent(evt) {
  const effect = effectMap[evt.kind];
  if (effect) {
    effect.spawn(positionFromEvent(evt), evt);
  }
}
```

### Position Extraction

`positionFromEvent(evt)` reads `x`, `y`, `z` from the event and applies the `invertX` config flag (mirrors X axis for camera orientation). Returns a `BABYLON.Vector3`.

### Impact Factor

For `missileHit` events, the `speed` field is normalized to a 0–1 `impactFactor` using `VFX_CONFIG.impactSpeedMin` (1.5) and `VFX_CONFIG.impactSpeedMax` (24). This scales particle count, burst speed, and fragment size proportionally — light taps produce small bursts, hard hits produce larger ones.

## Effects Detail

### Explosion Effect (`effects/explosion.js`)

Triggered by `kind: "explosion"`. Spawns four sub-effects simultaneously at the detonation position:

**1. Fire Particles** — Babylon.js `ParticleSystem`
- Additive blend mode (glow effect)
- Color ramp: white → orange → red → dark (via `color1`, `color2`, `colorDead`)
- Sphere emitter, radius proportional to blast radius
- Short burst emission window (~50ms `targetStopDuration`)
- Self-disposes after max particle lifetime

**2. Smoke Particles** — Babylon.js `ParticleSystem`
- Standard blend mode (normal transparency)
- Gray tones, longer lifetime than fire (~2.2s)
- Positive gravity (particles rise)
- Sphere emitter, tight radius

**3. Spark Particles** — Babylon.js `ParticleSystem`
- Additive blend, stretched billboard mode (motion lines)
- Yellow/orange, high speed, strong negative gravity (fast falloff)
- Very short burst window (~30ms)

**4. Fragment Burst** — delegates to `missileHitEffect.spawn()` with `{ speed: VFX_CONFIG.impactSpeedMax }` (produces impactFactor = 1.0)
- Reuses the same fragment burst as missile-on-block hits
- Provides debris chunks at the explosion center

All four particle systems use `renderingGroupId = 2` to layer above game objects.

### Missile Hit Effect (`effects/missileHit.js`)

Triggered by `kind: "missileHit"`. Spawns geometric tetrahedron fragments that burst outward from the impact point.

**Mesh Generation:**
- Custom tetrahedron geometry (4 vertices, 4 triangle faces) via `BABYLON.VertexData`
- Randomized size within configured range
- Shared gray `StandardMaterial` (from `textures.js`)

**Animation (per-frame via `scene.onBeforeRenderObservable`):**
- Each fragment has: position, velocity vector, spin vector
- Uses `scene.deltaTime / 1000` (seconds) for frame-rate-independent physics
- Velocity updated by gravity × dt each frame
- Position updated by velocity × dt each frame
- Rotation updated by spin × dt each frame
- `t` progresses based on elapsed wall time vs `durationMs`, not frame count
- Scale interpolated linearly from 1.0 to 0.0 over duration
- Observer self-removes and meshes dispose when `t >= 1`

**Impact Scaling:**
- `impactFactor` (from event speed) scales: fragment count, burst speed, fragment size
- Floor set by `minScale` config to ensure even light hits produce visible fragments

## Shared Textures

Created once by `textures.js`, passed to all effects:

| Texture | Dimensions | Technique | Used By |
|---------|-----------|-----------|---------|
| Explosion | 64x64 | Radial gradient: white center → orange → red → transparent edge | Fire particles |
| Smoke | 64x64 | Radial gradient: dark gray center → transparent edge | Smoke particles |
| Spark | 8x64 | Linear gradient: transparent → bright yellow → transparent | Spark streaks |

**Fragment Material:** `StandardMaterial` with gray diffuse (`0.35`), subtle emissive (`0.18`), no specular. Shared across all tetrahedron fragment meshes.

## Config Structure

`vfxConfig.js` exports:

```js
export const VFX_CONFIG = {
  invertX: false,
  impactSpeedMin: 1.5,
  impactSpeedMax: 24,

  missileHit: {
    count: 5,
    durationMs: 1200,
    speed: 15,
    gravity: -7.5,
    size: 0.5,
    minScale: 0.1,
  },

  explosion: {
    fire:   { count: 40, durationMs: 500, speed: 14, size: 1.8, gravity: -4 },
    smoke:  { count: 28, durationMs: 2200, speed: 2.5, size: 5, gravity: 1.8 },
    sparks: { count: 60, durationMs: 900, speed: 18, size: 0.22, gravity: -14, width: 0.12 },
    fragments: true,
  },
};
```

All values are ported from rufus-prototype defaults. Each effect reads from its own sub-key.

## Integration Points

### 1. Client: `network.js` — Event Routing

Declare at module scope (alongside `soundSystem`):

```js
let vfxManager = null;
```

Initialize in the `message.type === "welcome"` handler, after `loadLevel` completes:

```js
const { createVfxManager } = await import("./vfx/vfxManager.js");
vfxManager = createVfxManager(scene);
```

In the `message.type === "event"` loop (line ~152):

```js
if (evt.kind === "explosion" || evt.kind === "missileHit") {
  vfxManager?.handleEvent(evt);
}
```

Clear effects on all reset paths (mirrors existing `clearDestructionVisuals()` calls):
- `evt.kind === "reset"` → `vfxManager?.clearEffects()`
- `message.type === "roundStarted"` → `vfxManager?.clearEffects()`
- `message.type === "matchReset"` → `vfxManager?.clearEffects()`

### 2. Server: `fragmentation.js` — New `missileHit` Event

In `shatterBlock()`, next to the existing `broadcastSfx("missile_fragments_block", ...)` call (line 17), add a companion VFX event broadcast:

```js
broadcast({
  type: "event",
  tick: gameState.tick,
  events: [{
    kind: "missileHit",
    x: block.x,
    y: block.y,
    z: block.z,
    speed: missileSpeed,
  }],
});
```

This fires when a block actually shatters — the moment debris is visually appropriate. One broadcast call next to the existing SFX call. No new server modules. The `broadcast` import already exists in `fragmentation.js`.

### 3. No Changes Needed

- `engine.js` — scene, rendering groups, render loop all work as-is
- `level.js` — crack stages and fragment shrinking are independent systems
- `sound.js` — SFX system is fully decoupled from VFX
- `state.js` — no state changes needed
- Post-processing — additive blend on ParticleSystem handles glow without a bloom pipeline

## Effect Lifecycle

### Particle-Based Effects (fire, smoke, sparks)

1. Create `ParticleSystem` with short `targetStopDuration` (burst emission window)
2. Particles emit during the burst window, then emission stops
3. `onStoppedObservable` fires → schedule `dispose()` via `setTimeout` after max particle lifetime + 100ms buffer
4. Store the timeout ID in the tracking Set entry so `clearEffects()` can cancel pending timeouts
5. On dispose (whether natural or forced): remove from tracking Set, cancel timeout if pending, call `system.dispose(false)`

### Mesh-Based Effects (fragment burst)

1. Create tetrahedron meshes at impact position with random velocities
2. Register `scene.onBeforeRenderObservable` observer for per-frame animation
3. Each frame: apply gravity to velocity, update position/rotation/scale (dt-based, see Animation section)
4. When animation progress `t >= 1`: remove observer, dispose all meshes, remove from tracking Map
5. Manager tracks each burst in a `Map<number, { observer, meshes[] }>` keyed by auto-incrementing burst ID

### Bulk Cleanup

`clearEffects()` iterates all tracked systems and meshes:
- Particle systems: cancel pending timeout, call `dispose(false)` (don't dispose texture, it's shared)
- Mesh bursts: remove observer, dispose each mesh
- Clear all tracking collections (Set and Map)

`dispose()` calls `clearEffects()` then disposes shared textures and materials via `sharedTextures.dispose()`.

## Files Changed Summary

| File | Change |
|------|--------|
| `public/client/vfx/vfxManager.js` | **New** — effect registry and lifecycle |
| `public/client/vfx/vfxConfig.js` | **New** — VFX parameters |
| `public/client/vfx/textures.js` | **New** — procedural textures and shared material |
| `public/client/vfx/effects/explosion.js` | **New** — bomb detonation effect |
| `public/client/vfx/effects/missileHit.js` | **New** — missile impact effect |
| `public/client/network.js` | **Modified** — route VFX events, init manager |
| `server/game/fragmentation.js` | **Modified** — broadcast `missileHit` event in `shatterBlock()` |
