# VFX Particle System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add client-side explosion and missile-hit visual effects using Babylon.js particle systems and custom mesh geometry, with a registry pattern for future effects.

**Architecture:** Factory-based VFX manager routes server events to effect modules. Shared procedural textures are created once and passed to all effects. Each effect module exports `spawn()`, `clear()`, `dispose()` methods. The manager tracks all active particle systems and mesh bursts for bulk cleanup on round reset.

**Tech Stack:** Babylon.js (global `BABYLON`), ES modules, procedural `DynamicTexture` for particles, custom `VertexData` tetrahedrons for fragments.

---

### Task 1: VFX Config

**Files:**
- Create: `public/client/vfx/vfxConfig.js`

- [ ] **Step 1: Create the config file**

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

- [ ] **Step 2: Commit**

```bash
git add public/client/vfx/vfxConfig.js
git commit -m "feat(vfx): add VFX config with explosion and missile-hit params"
```

---

### Task 2: Shared Textures

**Files:**
- Create: `public/client/vfx/textures.js`

- [ ] **Step 1: Create the shared textures factory**

This file creates three procedural `DynamicTexture`s and one `StandardMaterial`, all shared across effects. Effects never create their own textures.

```js
const { DynamicTexture, StandardMaterial, Color3 } = BABYLON;

export function createSharedTextures(scene) {
  const explosion = createExplosionTexture(scene);
  const smoke = createSmokeTexture(scene);
  const spark = createSparkTexture(scene);
  const fragmentMaterial = createFragmentMaterial(scene);

  function dispose() {
    explosion.dispose();
    smoke.dispose();
    spark.dispose();
    fragmentMaterial.dispose();
  }

  return { explosion, smoke, spark, fragmentMaterial, dispose };
}

function createExplosionTexture(scene) {
  const tex = new DynamicTexture("vfx_explosion", 64, scene, false);
  const ctx = tex.getContext();
  const cx = 32, cy = 32;
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.3, "rgba(255,160,40,1)");
  grad.addColorStop(0.7, "rgba(200,50,10,1)");
  grad.addColorStop(1, "rgba(100,20,0,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  tex.update();
  tex.hasAlpha = true;
  return tex;
}

function createSmokeTexture(scene) {
  const tex = new DynamicTexture("vfx_smoke", 64, scene, false);
  const ctx = tex.getContext();
  const cx = 32, cy = 32;
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 32);
  grad.addColorStop(0, "rgba(60,60,60,0.7)");
  grad.addColorStop(0.6, "rgba(80,80,80,0.3)");
  grad.addColorStop(1, "rgba(100,100,100,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  tex.update();
  tex.hasAlpha = true;
  return tex;
}

function createSparkTexture(scene) {
  const tex = new DynamicTexture("vfx_spark", { width: 8, height: 64 }, scene, false);
  const ctx = tex.getContext();
  const grad = ctx.createLinearGradient(4, 0, 4, 64);
  grad.addColorStop(0, "rgba(255,220,80,0)");
  grad.addColorStop(0.3, "rgba(255,240,120,1)");
  grad.addColorStop(0.7, "rgba(255,240,120,1)");
  grad.addColorStop(1, "rgba(255,220,80,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 8, 64);
  tex.update();
  tex.hasAlpha = true;
  return tex;
}

function createFragmentMaterial(scene) {
  const mat = new StandardMaterial("vfx_fragmentMat", scene);
  mat.diffuseColor = new Color3(0.35, 0.35, 0.35);
  mat.emissiveColor = new Color3(0.18, 0.18, 0.18);
  mat.specularColor = new Color3(0, 0, 0);
  return mat;
}
```

- [ ] **Step 2: Commit**

```bash
git add public/client/vfx/textures.js
git commit -m "feat(vfx): add procedural shared textures and fragment material"
```

---

### Task 3: Missile Hit Effect

**Files:**
- Create: `public/client/vfx/effects/missileHit.js`

- [ ] **Step 1: Create the missile-hit effect module**

This effect spawns tetrahedron mesh fragments that burst outward from the impact point. Each fragment has physics-like animation (gravity, velocity, spin) driven by `scene.onBeforeRenderObservable`. Fragment count, size, and speed scale with an `impactFactor` derived from the event's `speed` field.

```js
const { Vector3, VertexData, Mesh } = BABYLON;

export function createMissileHitEffect(scene, sharedTextures, config, _deps) {
  const activeBursts = new Map();
  let nextBurstId = 0;

  function spawn(position, evt) {
    const impactFactor = computeImpactFactor(evt.speed, config);
    const scale = Math.max(config.missileHit.minScale, impactFactor);
    const count = Math.max(1, Math.round(config.missileHit.count * scale));
    const burstSpeed = config.missileHit.speed * scale;
    const fragSize = config.missileHit.size * scale;

    const meshes = [];
    const fragments = [];

    for (let i = 0; i < count; i++) {
      const mesh = createTetrahedron(scene, fragSize, sharedTextures.fragmentMaterial);
      mesh.position.copyFrom(position);

      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI * 0.6;
      const sp = burstSpeed * (0.5 + Math.random() * 0.5);
      const vx = Math.sin(phi) * Math.cos(theta) * sp;
      const vy = Math.abs(Math.sin(phi) * Math.sin(theta) * sp);
      const vz = Math.cos(phi) * sp * 0.3;

      fragments.push({
        mesh,
        vx, vy, vz,
        spinX: (Math.random() - 0.5) * 10,
        spinY: (Math.random() - 0.5) * 10,
        spinZ: (Math.random() - 0.5) * 10,
      });
      meshes.push(mesh);
    }

    const startTime = performance.now();
    const durationMs = config.missileHit.durationMs;
    const gravity = config.missileHit.gravity;
    const burstId = nextBurstId++;

    const observer = scene.onBeforeRenderObservable.add(() => {
      const dt = (scene.deltaTime ?? 16) / 1000;
      const elapsed = performance.now() - startTime;
      const t = Math.min(elapsed / durationMs, 1);

      for (const frag of fragments) {
        frag.vy += gravity * dt;
        frag.mesh.position.x += frag.vx * dt;
        frag.mesh.position.y += frag.vy * dt;
        frag.mesh.position.z += frag.vz * dt;
        frag.mesh.rotation.x += frag.spinX * dt;
        frag.mesh.rotation.y += frag.spinY * dt;
        frag.mesh.rotation.z += frag.spinZ * dt;
        const s = 1 - t;
        frag.mesh.scaling.setAll(s);
      }

      if (t >= 1) {
        disposeBurst(burstId);
      }
    });

    activeBursts.set(burstId, { observer, meshes });
  }

  function disposeBurst(burstId) {
    const burst = activeBursts.get(burstId);
    if (!burst) return;
    scene.onBeforeRenderObservable.remove(burst.observer);
    for (const mesh of burst.meshes) {
      mesh.dispose(false, false);
    }
    activeBursts.delete(burstId);
  }

  function clear() {
    for (const burstId of [...activeBursts.keys()]) {
      disposeBurst(burstId);
    }
  }

  function dispose() {
    clear();
  }

  return { spawn, clear, dispose };
}

function computeImpactFactor(speed, config) {
  if (speed == null) return 1;
  const clamped = Math.max(config.impactSpeedMin, Math.min(speed, config.impactSpeedMax));
  return (clamped - config.impactSpeedMin) / (config.impactSpeedMax - config.impactSpeedMin);
}

function createTetrahedron(scene, size, material) {
  const h = size;
  const r = size * 0.6;
  const positions = [
    0, h, 0,
    r, -h * 0.3, 0,
    -r * 0.5, -h * 0.3, r * 0.87,
    -r * 0.5, -h * 0.3, -r * 0.87,
  ];
  const indices = [
    0, 1, 2,
    0, 2, 3,
    0, 3, 1,
    1, 3, 2,
  ];
  const normals = [];
  VertexData.ComputeNormals(positions, indices, normals);

  const vertexData = new VertexData();
  vertexData.positions = positions;
  vertexData.indices = indices;
  vertexData.normals = normals;

  const mesh = new Mesh("vfx_tetra", scene);
  vertexData.applyToMesh(mesh);
  mesh.material = material;
  mesh.isPickable = false;
  return mesh;
}
```

- [ ] **Step 2: Commit**

```bash
git add public/client/vfx/effects/missileHit.js
git commit -m "feat(vfx): add missile-hit tetrahedron fragment burst effect"
```

---

### Task 4: Explosion Effect

**Files:**
- Create: `public/client/vfx/effects/explosion.js`

- [ ] **Step 1: Create the explosion effect module**

Spawns four sub-effects at the detonation position: fire particles, smoke particles, spark particles, and a fragment burst (delegated to missileHit effect). All particle systems use `renderingGroupId = 2` to layer above game objects.

```js
const { ParticleSystem, Color4, Vector3 } = BABYLON;

export function createExplosionEffect(scene, sharedTextures, config, deps) {
  const activeSystems = new Set();
  const pendingTimeouts = new Set();

  function spawn(position, evt) {
    const radius = evt.radius ?? 2;
    const cfg = config.explosion;

    spawnFire(position, radius, cfg.fire);
    spawnSmoke(position, cfg.smoke);
    spawnSparks(position, cfg.sparks);

    if (cfg.fragments && deps?.missileHit) {
      deps.missileHit.spawn(position, { speed: config.impactSpeedMax });
    }
  }

  function spawnFire(position, radius, cfg) {
    const ps = new ParticleSystem("vfx_fire", cfg.count, scene);
    ps.particleTexture = sharedTextures.explosion;
    ps.blendMode = ParticleSystem.BLENDMODE_ADD;
    ps.renderingGroupId = 2;

    ps.emitter = position.clone();
    ps.createSphereEmitter(radius * 0.4);

    ps.minLifeTime = cfg.durationMs / 1000 * 0.6;
    ps.maxLifeTime = cfg.durationMs / 1000;
    ps.minSize = cfg.size * 0.5;
    ps.maxSize = cfg.size;
    ps.minEmitPower = cfg.speed * 0.6;
    ps.maxEmitPower = cfg.speed;
    ps.emitRate = cfg.count / 0.05;

    ps.color1 = new Color4(1, 1, 1, 1);
    ps.color2 = new Color4(1, 0.6, 0.15, 1);
    ps.colorDead = new Color4(0.4, 0.05, 0, 0);

    ps.gravity = new Vector3(0, cfg.gravity, 0);
    ps.targetStopDuration = 0.05;
    ps.disposeOnStop = false;

    ps.start();
    activeSystems.add(ps);

    ps.onStoppedObservable.addOnce(() => {
      const timeoutId = setTimeout(() => {
        pendingTimeouts.delete(timeoutId);
        disposeSystem(ps);
      }, (ps.maxLifeTime * 1000) + 100);
      pendingTimeouts.add(timeoutId);
    });
  }

  function spawnSmoke(position, cfg) {
    const ps = new ParticleSystem("vfx_smoke", cfg.count, scene);
    ps.particleTexture = sharedTextures.smoke;
    ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    ps.renderingGroupId = 2;

    ps.emitter = position.clone();
    ps.createSphereEmitter(0.3);

    ps.minLifeTime = cfg.durationMs / 1000 * 0.6;
    ps.maxLifeTime = cfg.durationMs / 1000;
    ps.minSize = cfg.size * 0.3;
    ps.maxSize = cfg.size;
    ps.minEmitPower = cfg.speed * 0.5;
    ps.maxEmitPower = cfg.speed;
    ps.emitRate = cfg.count / 0.08;

    ps.color1 = new Color4(0.4, 0.4, 0.4, 0.6);
    ps.color2 = new Color4(0.3, 0.3, 0.3, 0.4);
    ps.colorDead = new Color4(0.2, 0.2, 0.2, 0);

    ps.gravity = new Vector3(0, cfg.gravity, 0);
    ps.targetStopDuration = 0.08;
    ps.disposeOnStop = false;

    ps.start();
    activeSystems.add(ps);

    ps.onStoppedObservable.addOnce(() => {
      const timeoutId = setTimeout(() => {
        pendingTimeouts.delete(timeoutId);
        disposeSystem(ps);
      }, (ps.maxLifeTime * 1000) + 100);
      pendingTimeouts.add(timeoutId);
    });
  }

  function spawnSparks(position, cfg) {
    const ps = new ParticleSystem("vfx_sparks", cfg.count, scene);
    ps.particleTexture = sharedTextures.spark;
    ps.blendMode = ParticleSystem.BLENDMODE_ADD;
    ps.billboardMode = ParticleSystem.BILLBOARDMODE_STRETCHED;
    ps.renderingGroupId = 2;

    ps.emitter = position.clone();
    ps.createSphereEmitter(0.2);

    ps.minLifeTime = cfg.durationMs / 1000 * 0.4;
    ps.maxLifeTime = cfg.durationMs / 1000;
    ps.minSize = cfg.size;
    ps.maxSize = cfg.size;
    ps.minScaleX = cfg.width / cfg.size;
    ps.maxScaleX = cfg.width / cfg.size;
    ps.minEmitPower = cfg.speed * 0.7;
    ps.maxEmitPower = cfg.speed;
    ps.emitRate = cfg.count / 0.03;

    ps.color1 = new Color4(1, 0.95, 0.4, 1);
    ps.color2 = new Color4(1, 0.6, 0.15, 1);
    ps.colorDead = new Color4(0.6, 0.2, 0, 0);

    ps.gravity = new Vector3(0, cfg.gravity, 0);
    ps.targetStopDuration = 0.03;
    ps.disposeOnStop = false;

    ps.start();
    activeSystems.add(ps);

    ps.onStoppedObservable.addOnce(() => {
      const timeoutId = setTimeout(() => {
        pendingTimeouts.delete(timeoutId);
        disposeSystem(ps);
      }, (ps.maxLifeTime * 1000) + 100);
      pendingTimeouts.add(timeoutId);
    });
  }

  function disposeSystem(ps) {
    if (!activeSystems.has(ps)) return;
    ps.dispose(false);
    activeSystems.delete(ps);
  }

  function clear() {
    for (const timeoutId of pendingTimeouts) {
      clearTimeout(timeoutId);
    }
    pendingTimeouts.clear();

    for (const ps of activeSystems) {
      ps.dispose(false);
    }
    activeSystems.clear();
  }

  function dispose() {
    clear();
  }

  return { spawn, clear, dispose };
}
```

- [ ] **Step 2: Commit**

```bash
git add public/client/vfx/effects/explosion.js
git commit -m "feat(vfx): add explosion effect with fire, smoke, sparks, and fragments"
```

---

### Task 5: VFX Manager

**Files:**
- Create: `public/client/vfx/vfxManager.js`

- [ ] **Step 1: Create the VFX manager**

Single entry point for the VFX system. Creates shared textures, initializes effects, and routes events. The `positionFromEvent` helper reads `x`, `y`, `z` from an event and applies the `invertX` config flag.

```js
import { createSharedTextures } from "./textures.js";
import { createExplosionEffect } from "./effects/explosion.js";
import { createMissileHitEffect } from "./effects/missileHit.js";
import { VFX_CONFIG } from "./vfxConfig.js";

const { Vector3 } = BABYLON;

export function createVfxManager(scene) {
  const sharedTextures = createSharedTextures(scene);

  const missileHitEffect = createMissileHitEffect(scene, sharedTextures, VFX_CONFIG, null);
  const explosionEffect = createExplosionEffect(scene, sharedTextures, VFX_CONFIG, {
    missileHit: missileHitEffect,
  });

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

  function clearEffects() {
    for (const effect of Object.values(effectMap)) {
      effect.clear();
    }
  }

  function dispose() {
    clearEffects();
    for (const effect of Object.values(effectMap)) {
      effect.dispose();
    }
    sharedTextures.dispose();
  }

  return { handleEvent, clearEffects, dispose };
}
```

- [ ] **Step 2: Commit**

```bash
git add public/client/vfx/vfxManager.js
git commit -m "feat(vfx): add VFX manager with event routing and lifecycle"
```

---

### Task 6: Server — Broadcast `missileHit` Event

**Files:**
- Modify: `server/game/fragmentation.js:17`

The server already broadcasts the `explosion` event in `server/game/explosion.js:49-60` — no changes needed there. Only `fragmentation.js` needs a new `missileHit` event broadcast in `shatterBlock()`.

- [ ] **Step 1: Add the `missileHit` broadcast**

In `server/game/fragmentation.js`, add a broadcast call right after the existing `broadcastSfx` on line 17. The `broadcast` import already exists on line 5 and `gameState` is imported on line 3.

After line 17 (`broadcastSfx("missile_fragments_block", ...)`), add:

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

The full lines 16-29 should read:

```js
  const missileSpeed = Math.hypot(missile.vx ?? 0, missile.vy ?? 0, missile.vz ?? 0);
  broadcastSfx("missile_fragments_block", { speed: missileSpeed, x: block.x });

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

- [ ] **Step 2: Commit**

```bash
git add server/game/fragmentation.js
git commit -m "feat(vfx): broadcast missileHit event from shatterBlock"
```

---

### Task 7: Client Integration — Wire VFX Into `network.js`

**Files:**
- Modify: `public/client/network.js:10,117-119,131,149,152-167`

Three changes: declare `vfxManager` variable, initialize it after level loads, route events to it, and clear on reset paths.

- [ ] **Step 1: Declare `vfxManager` at module scope**

After line 10 (`const soundSystem = createSoundSystem();`), add:

```js
let vfxManager = null;
```

- [ ] **Step 2: Initialize VFX manager in the `welcome` handler**

Inside the `message.type === "welcome"` block, after `await loadLevel(message.level);` (line 117) and before `engine.runRenderLoop(...)` (line 118), add:

```js
    const { createVfxManager } = await import("./vfx/vfxManager.js");
    vfxManager = createVfxManager(scene);
```

The full welcome block (lines 112-121) should read:

```js
  if (message.type === "welcome") {
    if (message.config) serverConfig = message.config;
    playerEl.textContent = message.playerId;
    const { initTemplateRegistry } = await import("./templateRegistry.js");
    await initTemplateRegistry(message.templates ?? []);
    await loadLevel(message.level);
    const { createVfxManager } = await import("./vfx/vfxManager.js");
    vfxManager = createVfxManager(scene);
    engine.runRenderLoop(() => { scene.render(); });
    ready = true;
    return;
  }
```

- [ ] **Step 3: Route VFX events in the event loop**

In the `message.type === "event"` block (line 152-167), add VFX event routing inside the `for` loop. After the `sfx`/`sfxStart`/`sfxStop` block (line 163-165), add:

```js
      if (evt.kind === "explosion" || evt.kind === "missileHit") {
        vfxManager?.handleEvent(evt);
      }
```

- [ ] **Step 4: Clear VFX on reset paths**

Add `vfxManager?.clearEffects()` next to each existing `clearDestructionVisuals()` call:

1. In the `message.type === "roundStarted"` block (line 131), after `clearDestructionVisuals();`:

```js
    vfxManager?.clearEffects();
```

2. In the `evt.kind === "reset"` handler (line 161), after `clearDestructionVisuals();`:

```js
        vfxManager?.clearEffects();
```

3. In the `message.type === "matchReset"` block (line 143-150), after `matchEndEl.classList.add("hidden");` (line 145):

```js
    vfxManager?.clearEffects();
```

- [ ] **Step 5: Commit**

```bash
git add public/client/network.js
git commit -m "feat(vfx): wire VFX manager into client event routing and reset paths"
```

---

### Task 8: Manual Visual Testing

**Files:** None (verification only)

- [ ] **Step 1: Start the server locally**

```bash
npm start
```

Open the game in a browser.

- [ ] **Step 2: Test explosion VFX**

Trigger a bomb explosion in-game. Verify:
- Fire particles (orange/white glow) burst outward and fade
- Smoke particles (gray) rise and dissipate
- Spark streaks shoot outward and fall
- Tetrahedron fragments burst outward, spin, shrink, and disappear
- All four sub-effects originate from the same detonation point
- No console errors

- [ ] **Step 3: Test missile-hit VFX**

Fire a missile that shatters a block. Verify:
- Tetrahedron fragments burst from the impact point
- Fragment count and speed scale visibly with missile speed (fast hits = more/bigger fragments, slow hits = smaller bursts)
- Fragments have gravity (arc downward) and spin
- Fragments shrink to zero and disappear after ~1.2 seconds
- No console errors

- [ ] **Step 4: Test round reset cleanup**

Trigger a round reset while effects are active. Verify:
- All active particle systems disappear immediately
- All active fragments disappear immediately
- No orphaned meshes or particle systems remain
- No console errors after cleanup

- [ ] **Step 5: Test multiple rapid explosions**

Trigger several bombs in quick succession (chain explosions). Verify:
- Multiple simultaneous effects render without lag
- Each explosion has independent lifecycle
- All effects clean up properly when they finish

- [ ] **Step 6: Check invertX positioning**

Verify effects appear at the correct world positions. The `invertX: true` config mirrors the X axis — effects should appear at the visual location of the explosion/impact, not mirrored.

If the effects appear mirrored (on the wrong side), flip `invertX` to `false` in `vfxConfig.js`.
