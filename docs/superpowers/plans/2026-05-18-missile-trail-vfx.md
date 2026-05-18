# Missile Trail VFX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add continuous particle trails to trebuchet projectiles in flight, with three selectable styles (wind streaks, dust, motion blur) switchable via config.

**Architecture:** A new trail effect module follows the existing factory pattern (like `explosion.js` and `missileHit.js`). It maintains a `Map<meshId, ParticleSystem>` of active trails. The VFX manager exposes a `syncTrails()` method called every state tick from `network.js`, which diffs current missile IDs against active trails to attach/detach as needed. Two new procedural textures are added to the shared texture pool.

**Tech Stack:** Babylon.js `ParticleSystem` + `DynamicTexture` (global `BABYLON`), ES modules.

---

### Task 1: Trail Config

**Files:**
- Modify: `public/client/vfx/vfxConfig.js`

- [ ] **Step 1: Add the trail config section**

Add the `trail` property to the existing `VFX_CONFIG` object, after the `explosion` block:

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
    minScale: 0.4,
  },

  explosion: {
    fire:   { count: 40, durationMs: 500, speed: 14, size: 1.8, gravity: -4 },
    smoke:  { count: 28, durationMs: 2200, speed: 2.5, size: 5, gravity: 1.8 },
    sparks: { count: 60, durationMs: 900, speed: 18, size: 0.22, gravity: -14, width: 0.12 },
    fragments: true,
  },

  trail: {
    enabled: true,
    style: "wind",
    wind: { count: 15, durationMs: 200, speed: 0.5, size: 0.15, scaleX: 0.3, gravity: 0 },
    dust: { count: 10, durationMs: 600, speed: 1.5, size: 0.4, gravity: -1.5 },
    blur: { count: 6, durationMs: 150, speed: 0, size: 0.8, gravity: 0 },
  },
};
```

- [ ] **Step 2: Commit**

```bash
git add public/client/vfx/vfxConfig.js
git commit -m "feat(vfx): add trail config with wind, dust, blur styles"
```

---

### Task 2: Trail Textures

**Files:**
- Modify: `public/client/vfx/textures.js`

The wind streak texture is an 8x64 white linear gradient (same dimensions as the existing spark texture but white-to-transparent). The blur texture is a 32x32 gray radial gradient with soft edges.

- [ ] **Step 1: Add `createWindStreakTexture` function**

Add this function at the bottom of `textures.js`, after `createFragmentMaterial`:

```js
function createWindStreakTexture(scene) {
  const tex = new DynamicTexture("vfx_windStreak", { width: 8, height: 64 }, scene, false);
  const ctx = tex.getContext();
  const grad = ctx.createLinearGradient(4, 0, 4, 64);
  grad.addColorStop(0, "rgba(255,255,255,0)");
  grad.addColorStop(0.3, "rgba(255,255,255,0.8)");
  grad.addColorStop(0.7, "rgba(255,255,255,0.8)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 8, 64);
  tex.update();
  tex.hasAlpha = true;
  return tex;
}
```

- [ ] **Step 2: Add `createBlurTexture` function**

Add this function right after `createWindStreakTexture`:

```js
function createBlurTexture(scene) {
  const tex = new DynamicTexture("vfx_blur", 32, scene, false);
  const ctx = tex.getContext();
  const cx = 16, cy = 16;
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 16);
  grad.addColorStop(0, "rgba(140,140,140,0.4)");
  grad.addColorStop(0.6, "rgba(140,140,140,0.2)");
  grad.addColorStop(1, "rgba(140,140,140,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 32, 32);
  tex.update();
  tex.hasAlpha = true;
  return tex;
}
```

- [ ] **Step 3: Register the new textures in `createSharedTextures`**

Update the `createSharedTextures` function to create and return the new textures, and dispose them on cleanup:

```js
export function createSharedTextures(scene) {
  const explosion = createExplosionTexture(scene);
  const smoke = createSmokeTexture(scene);
  const spark = createSparkTexture(scene);
  const fragmentMaterial = createFragmentMaterial(scene);
  const windStreak = createWindStreakTexture(scene);
  const blur = createBlurTexture(scene);

  function dispose() {
    explosion.dispose();
    smoke.dispose();
    spark.dispose();
    fragmentMaterial.dispose();
    windStreak.dispose();
    blur.dispose();
  }

  return { explosion, smoke, spark, fragmentMaterial, windStreak, blur, dispose };
}
```

- [ ] **Step 4: Commit**

```bash
git add public/client/vfx/textures.js
git commit -m "feat(vfx): add wind streak and blur textures for missile trails"
```

---

### Task 3: Missile Trail Effect

**Files:**
- Create: `public/client/vfx/effects/missileTrail.js`

This is the core effect module. It contains three style factory functions and the trail lifecycle manager (attach, detach, sync, clear, dispose).

- [ ] **Step 1: Create the file with the style factories**

Create `public/client/vfx/effects/missileTrail.js`:

```js
const { ParticleSystem, Color4, Vector3 } = BABYLON;

export function createMissileTrailEffect(scene, sharedTextures, config) {
  const activeTrails = new Map();
  const pendingDisposals = new Set();

  const styleFactories = {
    wind: createWindTrail,
    dust: createDustTrail,
    blur: createBlurTrail,
  };

  function attachTrail(mesh) {
    if (activeTrails.has(mesh.uniqueId)) return;
    const cfg = config.trail;
    if (!cfg.enabled) return;

    const factory = styleFactories[cfg.style];
    if (!factory) return;

    const ps = factory(scene, mesh, sharedTextures, cfg[cfg.style]);
    ps.start();
    activeTrails.set(mesh.uniqueId, ps);
  }

  function scheduleDisposal(ps) {
    ps.stop();
    const timeoutId = setTimeout(() => {
      pendingDisposals.delete(timeoutId);
      ps.dispose(false);
    }, ps.maxLifeTime * 1000 + 100);
    pendingDisposals.add(timeoutId);
  }

  function detachTrail(mesh) {
    const ps = activeTrails.get(mesh.uniqueId);
    if (!ps) return;
    activeTrails.delete(mesh.uniqueId);
    scheduleDisposal(ps);
  }

  function syncTrails(missileIds, visualObjects) {
    if (!config.trail.enabled) {
      if (activeTrails.size > 0) clear();
      return;
    }

    const currentMissileSet = new Set(missileIds);

    for (const [meshId, ps] of activeTrails) {
      let found = false;
      for (const id of currentMissileSet) {
        const mesh = visualObjects.get(id);
        if (mesh && mesh.uniqueId === meshId) {
          found = true;
          break;
        }
      }
      if (!found) {
        activeTrails.delete(meshId);
        scheduleDisposal(ps);
      }
    }

    for (const id of missileIds) {
      const mesh = visualObjects.get(id);
      if (mesh && !activeTrails.has(mesh.uniqueId)) {
        attachTrail(mesh);
      }
    }
  }

  function clear() {
    for (const timeoutId of pendingDisposals) {
      clearTimeout(timeoutId);
    }
    pendingDisposals.clear();

    for (const ps of activeTrails.values()) {
      ps.stop();
      ps.dispose(false);
    }
    activeTrails.clear();
  }

  function dispose() {
    clear();
  }

  return { attachTrail, detachTrail, syncTrails, clear, dispose };
}

function createWindTrail(scene, mesh, textures, cfg) {
  const emitRate = cfg.count / (cfg.durationMs / 1000);
  const ps = new ParticleSystem("vfx_trail_wind", cfg.count * 2, scene);
  ps.particleTexture = textures.windStreak;
  ps.blendMode = ParticleSystem.BLENDMODE_ADD;
  ps.billboardMode = ParticleSystem.BILLBOARDMODE_STRETCHED;
  ps.renderingGroupId = 2;
  ps.disposeOnStop = false;

  ps.emitter = mesh;

  ps.minLifeTime = cfg.durationMs / 1000 * 0.6;
  ps.maxLifeTime = cfg.durationMs / 1000;
  ps.minSize = cfg.size;
  ps.maxSize = cfg.size;
  ps.minScaleX = cfg.scaleX;
  ps.maxScaleX = cfg.scaleX;
  ps.minEmitPower = cfg.speed * 0.5;
  ps.maxEmitPower = cfg.speed;
  ps.emitRate = emitRate;

  ps.color1 = new Color4(1, 1, 1, 0.8);
  ps.color2 = new Color4(0.9, 0.9, 0.9, 0.6);
  ps.colorDead = new Color4(1, 1, 1, 0);

  ps.gravity = new Vector3(0, cfg.gravity, 0);

  return ps;
}

function createDustTrail(scene, mesh, textures, cfg) {
  const emitRate = cfg.count / (cfg.durationMs / 1000);
  const ps = new ParticleSystem("vfx_trail_dust", cfg.count * 2, scene);
  ps.particleTexture = textures.smoke;
  ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
  ps.billboardMode = ParticleSystem.BILLBOARDMODE_ALL;
  ps.renderingGroupId = 2;
  ps.disposeOnStop = false;

  ps.emitter = mesh;
  ps.createSphereEmitter(0.1);

  ps.minLifeTime = cfg.durationMs / 1000 * 0.6;
  ps.maxLifeTime = cfg.durationMs / 1000;
  ps.minSize = cfg.size * 0.75;
  ps.maxSize = cfg.size * 1.5;
  ps.minEmitPower = cfg.speed * 0.7;
  ps.maxEmitPower = cfg.speed;
  ps.emitRate = emitRate;

  ps.color1 = new Color4(194 / 255, 164 / 255, 120 / 255, 0.6);
  ps.color2 = new Color4(194 / 255, 164 / 255, 120 / 255, 0.4);
  ps.colorDead = new Color4(194 / 255, 164 / 255, 120 / 255, 0);

  ps.gravity = new Vector3(0, cfg.gravity, 0);

  return ps;
}

function createBlurTrail(scene, mesh, textures, cfg) {
  const emitRate = cfg.count / (cfg.durationMs / 1000);
  const ps = new ParticleSystem("vfx_trail_blur", cfg.count * 2, scene);
  ps.particleTexture = textures.blur;
  ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
  ps.billboardMode = ParticleSystem.BILLBOARDMODE_ALL;
  ps.renderingGroupId = 2;
  ps.disposeOnStop = false;

  ps.emitter = mesh;

  ps.minLifeTime = cfg.durationMs / 1000 * 0.6;
  ps.maxLifeTime = cfg.durationMs / 1000;
  ps.minSize = cfg.size;
  ps.maxSize = cfg.size;
  ps.minEmitPower = cfg.speed;
  ps.maxEmitPower = cfg.speed;
  ps.emitRate = emitRate;

  ps.color1 = new Color4(140 / 255, 140 / 255, 140 / 255, 0.4);
  ps.color2 = new Color4(140 / 255, 140 / 255, 140 / 255, 0.3);
  ps.colorDead = new Color4(140 / 255, 140 / 255, 140 / 255, 0);

  ps.gravity = new Vector3(0, cfg.gravity, 0);

  return ps;
}
```

- [ ] **Step 2: Commit**

```bash
git add public/client/vfx/effects/missileTrail.js
git commit -m "feat(vfx): add missile trail effect with wind, dust, blur styles"
```

---

### Task 4: Wire Trail into VFX Manager

**Files:**
- Modify: `public/client/vfx/vfxManager.js`

- [ ] **Step 1: Import the trail effect**

Add at the top of `vfxManager.js`, after the existing imports:

```js
import { createMissileTrailEffect } from "./effects/missileTrail.js";
```

- [ ] **Step 2: Create the trail effect instance**

Inside `createVfxManager`, after the `explosionEffect` creation (line 12), add:

```js
const trailEffect = createMissileTrailEffect(scene, sharedTextures, VFX_CONFIG);
```

- [ ] **Step 3: Add `syncTrails` method and update `clearEffects` / `dispose`**

Replace the `clearEffects`, `dispose`, and return statement with:

```js
  function syncTrails(missileIds, visualObjects) {
    trailEffect.syncTrails(missileIds, visualObjects);
  }

  function clearEffects() {
    for (const effect of Object.values(effectMap)) {
      effect.clear();
    }
    trailEffect.clear();
  }

  function dispose() {
    clearEffects();
    for (const effect of Object.values(effectMap)) {
      effect.dispose();
    }
    trailEffect.dispose();
    sharedTextures.dispose();
  }

  return { handleEvent, syncTrails, clearEffects, dispose };
```

The full file after changes:

```js
import { createSharedTextures } from "./textures.js";
import { createExplosionEffect } from "./effects/explosion.js";
import { createMissileHitEffect } from "./effects/missileHit.js";
import { createMissileTrailEffect } from "./effects/missileTrail.js";
import { VFX_CONFIG } from "./vfxConfig.js";

const { Vector3 } = BABYLON;

export function createVfxManager(scene) {
  const sharedTextures = createSharedTextures(scene);

  const missileHitEffect = createMissileHitEffect(scene, sharedTextures, VFX_CONFIG, null);
  const explosionEffect = createExplosionEffect(scene, sharedTextures, VFX_CONFIG, {
    missileHit: missileHitEffect,
  });
  const trailEffect = createMissileTrailEffect(scene, sharedTextures, VFX_CONFIG);

  const effectMap = {
    "explosion": explosionEffect,
    "missileHit": missileHitEffect,
  };

  function positionFromEvent(evt) {
    const x = VFX_CONFIG.invertX ? -evt.x : evt.x;
    return new Vector3(x, evt.y, evt.z);
  }

  function handleEvent(evt) {
    const effect = effectMap[evt.kind];
    if (effect) {
      effect.spawn(positionFromEvent(evt), evt);
    }
  }

  function syncTrails(missileIds, visualObjects) {
    trailEffect.syncTrails(missileIds, visualObjects);
  }

  function clearEffects() {
    for (const effect of Object.values(effectMap)) {
      effect.clear();
    }
    trailEffect.clear();
  }

  function dispose() {
    clearEffects();
    for (const effect of Object.values(effectMap)) {
      effect.dispose();
    }
    trailEffect.dispose();
    sharedTextures.dispose();
  }

  return { handleEvent, syncTrails, clearEffects, dispose };
}
```

- [ ] **Step 4: Commit**

```bash
git add public/client/vfx/vfxManager.js
git commit -m "feat(vfx): wire trail effect into VFX manager"
```

---

### Task 5: Integrate Trail Sync in Network

**Files:**
- Modify: `public/client/network.js`

- [ ] **Step 1: Import `visualObjects` from state**

On line 3 of `network.js`, add `visualObjects` to the existing import from `./state.js`:

```js
import { applyState, latestObjectStates, visualObjects } from "./state.js";
```

(Previously: `import { applyState, latestObjectStates } from "./state.js";`)

- [ ] **Step 2: Add `syncTrails` call in the state handler**

In the `message.type === "state"` block (line 179), add the trail sync **before** the existing `updateScores` call. This ensures trails are detached before `removeStaleVisuals` disposes the emitter meshes:

Replace:

```js
  if (message.type === "state") {
    updateScores(message.scores, false);
    const prevStates = new Map(latestObjectStates);
    removeStaleVisuals(message.objects ?? []);
```

With:

```js
  if (message.type === "state") {
    const missileIds = (message.objects ?? [])
      .filter(o => o.id.startsWith("missiles/"))
      .map(o => o.id);
    vfxManager?.syncTrails(missileIds, visualObjects);

    updateScores(message.scores, false);
    const prevStates = new Map(latestObjectStates);
    removeStaleVisuals(message.objects ?? []);
```

- [ ] **Step 3: Commit**

```bash
git add public/client/network.js
git commit -m "feat(vfx): sync missile trails on every state tick"
```

---

### Task 6: Manual Verification

No automated tests — this is a client-side visual effect using a global Babylon.js runtime. Verify by playing the game.

- [ ] **Step 1: Start the server**

```bash
node server/main.js
```

Open the game in a browser at `http://localhost` (or whichever port the server runs on).

- [ ] **Step 2: Fire a missile and verify trail appears**

Launch a trebuchet projectile. A particle trail should follow the missile mesh through its entire flight arc. With the default `"wind"` style, you should see thin white speed lines stretching behind the projectile.

- [ ] **Step 3: Verify trail disappears when missile is removed**

When the missile hits a block or goes out of bounds, the trail should stop and be disposed — no orphaned particle systems left running.

- [ ] **Step 4: Test style switching**

Open browser console and change the style at runtime:

```js
// Import config — adjust path if using ES modules via script type="module"
// Or just access it if the module is already loaded
VFX_CONFIG.trail.style = "dust";
```

Fire another missile — the new trail should use the dust style (brownish particles drifting down). Try `"blur"` as well (gray ghost copies).

If `VFX_CONFIG` is not on `window`, temporarily add `window.VFX_CONFIG = VFX_CONFIG;` to `vfxConfig.js` for testing, then remove it.

- [ ] **Step 5: Verify cleanup on round/match reset**

Start a new round or reset the match. All active trails should be cleaned up — no lingering particle effects from the previous round.

- [ ] **Step 6: Test with trails disabled**

Set `VFX_CONFIG.trail.enabled = false` in the config file. Fire a missile — no trail should appear.
