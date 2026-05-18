# Missile Trail VFX Design

## Goal

Add a continuous particle trail to trebuchet projectiles in flight so they feel like they're really moving. Three trail styles are implemented, selectable via config, so the best one can be chosen through playtesting.

## Trail Styles

### Wind Streaks
Thin white/gray speed lines trailing behind the projectile. Conveys air being cut by a fast heavy object.
- Texture: elongated white-to-transparent gradient (reuse spark texture pattern, 8x64)
- Blend: additive
- Billboard: stretched (aligns to velocity)
- Count: ~15 particles alive at once (emitRate = 75/sec)
- Lifetime: 200ms (short, tight trail)
- Speed: low (0.5) — particles mostly stay where emitted
- Size: 0.15 height, elongated via `minScaleX: 0.3, maxScaleX: 0.3` (width/height ratio forces streak shape independent of velocity magnitude)
- Color: white at 80% alpha fading to transparent
- Gravity: 0

### Dust Trail
Light dusty particles shedding off the stone as it flies. Subtle and earthy.
- Texture: reuse existing smoke texture
- Blend: standard (alpha)
- Billboard: all (face camera)
- Count: ~10 particles alive at once (emitRate = 17/sec)
- Lifetime: 600ms (lingers a bit)
- Speed: 1.5 with some random spread
- Size: 0.3–0.6 (randomized)
- Color: tan/brown (194,164,120) fading to transparent
- Gravity: -1.5 (slight downward drift)

### Motion Blur
Short translucent ghost copies trailing behind the projectile. Classic speed effect.
- Texture: radial gradient, stone-gray, soft edges (new 32x32 texture)
- Blend: standard (alpha)
- Billboard: all (face camera) — speed 0 means no velocity vector, so stretched mode has no direction to align to
- Count: ~6 particles alive at once (emitRate = 40/sec)
- Lifetime: 150ms (very short, tight ghost trail)
- Speed: 0 — particles stay exactly where emitted
- Size: 0.8 (matches approximate projectile size)
- Color: gray (140,140,140) at 40% alpha, fading to 0
- Gravity: 0

## Config

New section in `vfxConfig.js`:

```javascript
trail: {
  enabled: true,
  style: "wind",        // "wind" | "dust" | "blur"
  wind:  { count: 15, durationMs: 200, speed: 0.5, size: 0.15, scaleX: 0.3, gravity: 0 },
  dust:  { count: 10, durationMs: 600, speed: 1.5, size: 0.4, gravity: -1.5 },
  blur:  { count: 6,  durationMs: 150, speed: 0,   size: 0.8, gravity: 0 },
}
```

All styles set `renderingGroupId = 2` to match existing VFX particle systems.

Switching styles at runtime: change `VFX_CONFIG.trail.style` — new missiles pick it up immediately, existing trails stay until their missile is removed.

## Architecture

### New File: `public/client/vfx/effects/missileTrail.js`

Exports `createMissileTrailEffect(scene, sharedTextures, config)` returning:

```javascript
{
  attachTrail(mesh),   // creates ParticleSystem on mesh, stores in activeTrails map
  detachTrail(mesh),   // stops + disposes particle system for that mesh
  syncTrails(missileIds, visualObjects),  // attach new, detach removed
  clear(),             // detach all
  dispose(),           // clear + cleanup
}
```

Each style is a factory function that returns a configured `BABYLON.ParticleSystem`:
- `createWindTrail(scene, mesh, textures, config)`
- `createDustTrail(scene, mesh, textures, config)`
- `createBlurTrail(scene, mesh, textures, config)`

The emitter is set to the missile mesh directly — Babylon auto-follows position.

### New Textures in `textures.js`

- `createWindStreakTexture(scene)` — 8x64 white linear gradient (similar to spark but white)
- `createBlurTexture(scene)` — 32x32 gray radial gradient with soft edges
- Dust trail reuses existing `smoke` texture

### VFX Manager Changes (`vfxManager.js`)

Add trail effect to the manager:

```javascript
const trailEffect = createMissileTrailEffect(scene, sharedTextures, VFX_CONFIG);
```

Expose new methods:
- `syncTrails(missileIds, visualObjects)` — delegates to `trailEffect.syncTrails()`
- Update `clearEffects()` to also call `trailEffect.clear()`
- Update `dispose()` to also call `trailEffect.dispose()`

### Integration in `network.js`

Add `visualObjects` to the import from `./state.js`.

In the `message.type === "state"` handler, call `syncTrails` **before** `removeStaleVisuals` so trails are detached before their emitter meshes are disposed:

```javascript
if (message.type === "state") {
    const missileIds = (message.objects ?? [])
      .filter(o => o.id.startsWith("missiles/"))
      .map(o => o.id);
    vfxManager?.syncTrails(missileIds, visualObjects);

    updateScores(message.scores, false);
    const prevStates = new Map(latestObjectStates);
    removeStaleVisuals(message.objects ?? []);
    ensureVisualsForState(message.objects ?? []);
    applyState(message);
    // ... hitStage logic
}
```

This syncs trails every state tick — attaches trails to new missiles, detaches from removed ones. Running it first ensures trails are cleaned up while their meshes still exist.

### Cleanup Paths

| Event | Action |
|---|---|
| Missile removed from state | `syncTrails` detaches trail (runs before `removeStaleVisuals`) |
| Round started / reset | `clearEffects()` → `trailEffect.clear()` |
| Match reset | `clearEffects()` → `trailEffect.clear()` |
| Level reload | `clearEffects()` → `trailEffect.clear()` (called before `reloadLevel` in both `roundStarted` and `matchReset` handlers) |

## Files Changed

| File | Change |
|---|---|
| `public/client/vfx/effects/missileTrail.js` | New — trail effect with 3 styles |
| `public/client/vfx/textures.js` | Add wind streak + blur textures |
| `public/client/vfx/vfxConfig.js` | Add `trail` config section |
| `public/client/vfx/vfxManager.js` | Wire trail effect, expose `syncTrails` |
| `public/client/network.js` | Call `syncTrails` after state updates |
