# SFX System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add server-authoritative sound event dispatch with a client-side Web Audio playback system.

**Architecture:** Server detects collisions/actions and broadcasts raw physics data (effect name, speed, x position) via the existing event message system. Client receives events, looks up effect config, computes volume/pitch/pan, and plays sounds using the Web Audio API. No audio math on the server; no game logic on the client.

**Tech Stack:** Node.js ES modules (server), Web Audio API (client), Havok physics collision observable (server)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `server/game/sound.js` | **Create** | SFX event constructors + broadcast helpers |
| `server/game/entities.js` | **Modify** | Add `isGroundName()` helper |
| `server/game/physics.js` | **Modify** | Fix arena collider prefix, enable collision callbacks on arena colliders |
| `server/game/collisions.js` | **Modify** | Expand to detect all collision pair types, emit sfx events |
| `server/game/input.js` | **Modify** | Emit trebuchet stretch start/stop sfx |
| `server/game/fragmentation.js` | **Modify** | Emit block break/crack sfx |
| `public/client/sound.js` | **Create** | Full Web Audio playback system |
| `public/client/network.js` | **Modify** | Route sfx events to sound system |
| `public/client/index.js` | **Modify** | Init sound system, wire toggle button |
| `public/client/engine.js` | **Modify** | Export `sfxToggleEl` DOM ref |
| `public/index.html` | **Modify** | Add SFX toggle button to HUD |
| `public/styles.css` | **Modify** | Style the SFX toggle button |
| `public/sounds/*.mp3` | **Copy** | 13 audio files from `origin/rufus-prototype` |

---

### Task 1: Copy audio assets from rufus-prototype branch

**Files:**
- Create: `public/sounds/` (13 `.mp3` files)

- [ ] **Step 1: Extract sound files from remote branch**

```bash
git checkout origin/rufus-prototype -- public/sounds/
```

This copies all 13 mp3 files into `public/sounds/` without switching branches.

- [ ] **Step 2: Verify files exist**

```bash
ls public/sounds/
```

Expected: 13 files listed:
```
block-hit-block.mp3       missile_bomb-hit.mp3       missile_hits_fragment.mp3
block_hit_ground.mp3      missile_crack_block.mp3    missile_hit_trebuchet.mp3
king_hit.mp3              missile_fragments_block.mp3  trebuche-stretch.mp3
missile-hit-ground.mp3    missile_hit_block.mp3      trebuchet_release.mp3
missile-hit-missile.mp3
```

- [ ] **Step 3: Commit**

```bash
git add public/sounds/
git commit -m "feat: add 13 sfx audio assets from rufus-prototype"
```

---

### Task 2: Create server sound module

**Files:**
- Create: `server/game/sound.js`

- [ ] **Step 1: Create `server/game/sound.js`**

```js
import { broadcast } from "../net/broadcast.js";
import { gameState } from "./state.js";

export function sfxEvent(effect, { speed = null, x = 0 } = {}) {
  return { kind: "sfx", effect, speed, x };
}

export function sfxStartEvent(effect, instanceId, { x = 0 } = {}) {
  return { kind: "sfxStart", effect, instanceId, x };
}

export function sfxStopEvent(instanceId) {
  return { kind: "sfxStop", instanceId };
}

export function broadcastSfx(effect, { speed = null, x = 0 } = {}) {
  broadcast({
    type: "event",
    tick: gameState.tick,
    events: [sfxEvent(effect, { speed, x })],
  });
}

export function broadcastSfxStart(effect, instanceId, { x = 0 } = {}) {
  broadcast({
    type: "event",
    tick: gameState.tick,
    events: [sfxStartEvent(effect, instanceId, { x })],
  });
}

export function broadcastSfxStop(instanceId) {
  broadcast({
    type: "event",
    tick: gameState.tick,
    events: [sfxStopEvent(instanceId)],
  });
}
```

- [ ] **Step 2: Verify the server starts**

```bash
npm run dev
```

Expected: server starts without import errors. Press Ctrl+C to stop.

- [ ] **Step 3: Commit**

```bash
git add server/game/sound.js
git commit -m "feat: add server sound module with sfx event helpers"
```

---

### Task 3: Fix arena collider prefix + add ground detection

**Files:**
- Modify: `server/game/physics.js:86`
- Modify: `server/game/entities.js`

- [ ] **Step 1: Fix arena collider TransformNode name in `server/game/physics.js`**

On line 86, the arena collider node is created without the `physics-` prefix that `objectIdFromBody()` requires. Change:

```js
const colNode = new TransformNode(`arena-col-${node.name}`, scene);
```

to:

```js
const colNode = new TransformNode(`physics-arena-col-${node.name}`, scene);
```

- [ ] **Step 2: Add `isGroundName()` to `server/game/entities.js`**

After the existing `isFragmentName` function (line 47), add:

```js
export function isGroundName(name) {
  return name === "ground" || name === "arena-col-Plane-ColVis";
}
```

`"ground"` matches the fallback ground body (`physics-ground` → `objectIdFromBody` strips prefix → `"ground"`). `"arena-col-Plane-ColVis"` matches the level1.glb arena ground collider (`physics-arena-col-Plane-ColVis` → stripped → `"arena-col-Plane-ColVis"`).

- [ ] **Step 3: Verify the server starts**

```bash
npm run dev
```

Expected: server starts. The arena collider log lines should now show `physics-arena-col-` prefix in the TransformNode names. Press Ctrl+C.

- [ ] **Step 4: Commit**

```bash
git add server/game/physics.js server/game/entities.js
git commit -m "fix: add physics- prefix to arena colliders, add isGroundName helper"
```

---

### Task 4: Enable collision callbacks on arena colliders

**Files:**
- Modify: `server/game/physics.js:86-98` (arena collider loop) and `server/game/physics.js:108-116` (fallback ground body)

The collision observable fires when *either* body in the pair has callbacks enabled. Missiles and blocks already have them (`createPhysicsBodies`, `createPhysicsBodyForObject`). The only missing piece is arena colliders — needed so block→ground collisions are detected.

No changes to `createPhysicsBodies()` or `createPhysicsBodyForObject()`.

- [ ] **Step 1: Enable collision callbacks on arena collider bodies**

In `createArenaColliders()`, after `aggregate.body.disablePreStep = true;` (line 97), add:

```js
      aggregate.body.setCollisionCallbackEnabled(true);
```

- [ ] **Step 2: Enable collision callbacks on the fallback ground body**

In the same function, after the fallback ground body's `aggregate.body.disablePreStep = true;` (line 115), add:

```js
    aggregate.body.setCollisionCallbackEnabled(true);
```

- [ ] **Step 3: Verify the server starts and no physics errors**

```bash
npm run dev
```

Expected: server starts normally with arena collider log lines. Open browser, verify game plays without errors in browser console. Press Ctrl+C.

- [ ] **Step 4: Commit**

```bash
git add server/game/physics.js
git commit -m "feat: enable collision callbacks on arena colliders for ground detection"
```

---

### Task 5: Expand collision handler

**Files:**
- Modify: `server/game/collisions.js`

This is the biggest server-side change. The collision handler needs to detect all pair types and emit sfx events.

- [ ] **Step 1: Add imports to `server/game/collisions.js`**

Add `isTrebuchetName`, `isKingName`, and the new `isGroundName` to the entities import, and import `broadcastSfx` from the sound module. Change:

```js
import { isMissileName, isBlockName, isFragmentName } from "./entities.js";
```

to:

```js
import { isMissileName, isBlockName, isFragmentName, isTrebuchetName, isKingName, isGroundName } from "./entities.js";
```

Add below the existing imports:

```js
import { broadcastSfx } from "./sound.js";
```

- [ ] **Step 2: Add helpers and per-tick sfx dedup**

The physics engine can fire multiple `COLLISION_STARTED` events for the same pair in one tick. `handleMissileBlockHit` already deduplicates via `pendingBlockHits`, but the direct `broadcastSfx` calls in the collision handler body need their own guard. Use the same pattern: a Map of pair key → last tick.

After the `objectIdFromBody` function (line 16), add:

```js
const sfxPairTicks = new Map();

function broadcastPairSfx(idA, idB, effect, opts) {
  const key = idA < idB ? `${idA}:${idB}` : `${idB}:${idA}`;
  if (sfxPairTicks.get(key) === gameState.tick) return;
  sfxPairTicks.set(key, gameState.tick);
  broadcastSfx(effect, opts);
}

function impactSpeed(a, b) {
  return Math.hypot(
    (a.vx ?? 0) - (b.vx ?? 0),
    (a.vy ?? 0) - (b.vy ?? 0),
    (a.vz ?? 0) - (b.vz ?? 0),
  );
}

function midpointX(a, b) {
  return (a.x + b.x) / 2;
}
```

Also update `clearCollisionState` (bottom of file) to clear the new Map:

```js
export function clearCollisionState() {
  pendingBlockHits.clear();
  sfxPairTicks.clear();
}
```

- [ ] **Step 3: Rewrite `handleMissileBlockHit` to emit the correct sfx for each outcome**

The spec defines three distinct missile→block effects:
- `missile_hit_block` — missile hits block, no structural change (block has no `maxHits`, or fragmentation/crack system both off)
- `missile_crack_block` — missile hits block, cracks it (crack system on, `hitStage < maxHits`)
- `missile_fragments_block` — missile hits block, breaks it (emitted inside `shatterBlock` in Task 7)

Replace the entire `handleMissileBlockHit` function with:

```js
function handleMissileBlockHit(missile, block) {
  if (missile.loadedInto) return;
  if (block.removing) return;

  const speed = Math.hypot(missile.vx ?? 0, missile.vy ?? 0, missile.vz ?? 0);
  const x = midpointX(missile, block);

  if (!block.maxHits) {
    broadcastSfx("missile_hit_block", { speed, x });
    return;
  }

  const hitKey = `${missile.id}:${block.id}`;
  const lastTick = pendingBlockHits.get(hitKey);
  if (lastTick === gameState.tick) return;
  pendingBlockHits.set(hitKey, gameState.tick);

  block.hitStage = (block.hitStage ?? 0) + 1;

  if (getConfig("crackSystem") && block.hitStage < block.maxHits) {
    broadcastSfx("missile_crack_block", { speed, x });
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
      broadcastSfx("missile_hit_block", { speed, x });
      deleteBlock(block);
    }
  }
}
```

Key changes vs. the original function:
- `loadedInto` and `removing` guards stay at the top (before any sfx), preventing spurious sounds from loaded missiles overlapping blocks
- Computes `speed` and `x` after the guards, before any sfx emission
- `!block.maxHits` → emits `missile_hit_block` (indestructible block bounce)
- Crack branch → emits `missile_crack_block` (existing `blockHit` visual event preserved)
- `shatterBlock` path → `missile_fragments_block` is emitted inside `shatterBlock` (Task 7)
- `deleteBlock` path (fragmentation off) → emits `missile_hit_block` (block removed, no fragments to shatter)

- [ ] **Step 4: Rewrite the collision handler body**

Replace the handler body inside `plugin.onCollisionObservable.add((event) => { ... })` (lines 88-111) with:

```js
  plugin.onCollisionObservable.add((event) => {
    if (event.type !== "COLLISION_STARTED") return;

    const idA = objectIdFromBody(event.collider);
    const idB = objectIdFromBody(event.collidedAgainst);
    if (!idA || !idB) return;

    const objA = gameObjects.get(idA);
    const objB = gameObjects.get(idB);

    const missileA = isMissileName(idA);
    const missileB = isMissileName(idB);

    // --- Missile collisions ---
    if (missileA || missileB) {
      const missile = missileA ? objA : objB;
      const other = missileA ? objB : objA;
      const otherId = missileA ? idB : idA;

      if (!missile) return;

      const missileSpeed = Math.hypot(missile.vx ?? 0, missile.vy ?? 0, missile.vz ?? 0);

      if (isBlockName(otherId) && !isFragmentName(otherId) && other) {
        handleMissileBlockHit(missile, other);
        return;
      }
      if (isFragmentName(otherId) && other) {
        broadcastPairSfx(idA, idB, "missile_hits_fragment", { speed: missileSpeed, x: missile.x });
        handleMissileFragmentHit(missile, other);
        return;
      }
      if (missileA && missileB) {
        if (objA && objB) {
          broadcastPairSfx(idA, idB, "missile_hit_missile", { speed: impactSpeed(objA, objB), x: midpointX(objA, objB) });
        }
        return;
      }
      if (isGroundName(otherId)) {
        broadcastPairSfx(idA, idB, "missile_hit_ground", { speed: missileSpeed, x: missile.x });
        return;
      }
      if (isTrebuchetName(otherId)) {
        if (missile.loadedInto) return;
        broadcastPairSfx(idA, idB, "missile_hit_trebuchet", { speed: missileSpeed, x: missile.x });
        return;
      }
      if (isKingName(otherId)) {
        broadcastPairSfx(idA, idB, "king_hit", { speed: missileSpeed, x: missile.x });
        return;
      }
      return;
    }

    // --- Non-missile collisions ---
    const blockA = isBlockName(idA) && !isFragmentName(idA);
    const blockB = isBlockName(idB) && !isFragmentName(idB);
    const groundA = isGroundName(idA);
    const groundB = isGroundName(idB);

    if (blockA && groundB && objA) {
      const speed = Math.hypot(objA.vx ?? 0, objA.vy ?? 0, objA.vz ?? 0);
      broadcastPairSfx(idA, idB, "block_hit_ground", { speed, x: objA.x });
      return;
    }
    if (blockB && groundA && objB) {
      const speed = Math.hypot(objB.vx ?? 0, objB.vy ?? 0, objB.vz ?? 0);
      broadcastPairSfx(idA, idB, "block_hit_ground", { speed, x: objB.x });
      return;
    }
    if (blockA && blockB && objA && objB) {
      const speed = impactSpeed(objA, objB);
      broadcastPairSfx(idA, idB, "block_hit_block", { speed, x: midpointX(objA, objB) });
      return;
    }
  });
```

- [ ] **Step 5: Verify the server starts**

```bash
npm run dev
```

Expected: server starts without errors. Open browser, play the game — no crashes. Check server console for no errors. Press Ctrl+C.

- [ ] **Step 6: Commit**

```bash
git add server/game/collisions.js
git commit -m "feat: expand collision handler with all pair types and sfx events"
```

---

### Task 6: Trebuchet sound events in input handler

**Files:**
- Modify: `server/game/input.js`

- [ ] **Step 1: Import sound helpers**

Add to the imports at the top of `server/game/input.js`:

```js
import { broadcastSfx, broadcastSfxStart, broadcastSfxStop } from "./sound.js";
```

- [ ] **Step 2: Emit `sfxStart` on aimStart**

Inside the `aimStart` handler (the `if (message.action === "aimStart")` block, after line 53 — `trebuchet.armAngle = restArmAngleForTrebuchet();`), add:

```js
    broadcastSfxStart("trebuchet_stretch", trebuchet.id, { x: trebuchet.x });
```

- [ ] **Step 3: Emit `sfxStop` + `sfx` on aimRelease**

The `sfxStop` must fire even if the state guards fail (wrong client, wrong fireState), otherwise the looping stretch sound gets stuck. Move the stop call to right after the trebuchet lookup, before the state guards. The release sfx stays after the guards since the trebuchet should only "whoosh" if it actually fires.

Replace the entire `aimRelease` block with:

```js
  if (message.action === "aimRelease") {
    const missile = gameObjects.get(message.entityId);
    if (!missile || !message.point || !missile.loadedInto) return;

    const trebuchet = gameObjects.get(missile.loadedInto);
    if (trebuchet) broadcastSfxStop(trebuchet.id);
    if (!trebuchet || trebuchet.aimedBy !== client.id || trebuchet.fireState !== ARM_STATE_AIMING) return;

    broadcastSfx("trebuchet_release", { x: trebuchet.x });
    updateTrebuchetAim(trebuchet, message.point);
    beginTrebuchetRelease(trebuchet);
  }
```

- [ ] **Step 4: Verify the server starts**

```bash
npm run dev
```

Expected: server starts without errors. Press Ctrl+C.

- [ ] **Step 5: Commit**

```bash
git add server/game/input.js
git commit -m "feat: emit trebuchet stretch and release sfx events"
```

---

### Task 7: Block break sound events in fragmentation

**Files:**
- Modify: `server/game/fragmentation.js`

- [ ] **Step 1: Import sound helper**

Add to the imports at the top of `server/game/fragmentation.js`:

```js
import { broadcastSfx } from "./sound.js";
```

- [ ] **Step 2: Emit sfx in `shatterBlock`**

At the top of the `shatterBlock` function (after `if (!block.fragmentTemplate) return;` on line 14), add:

```js
  const missileSpeed = Math.hypot(missile.vx ?? 0, missile.vy ?? 0, missile.vz ?? 0);
  broadcastSfx("missile_fragments_block", { speed: missileSpeed, x: block.x });
```

Note: `missileSpeed` is already computed later in the function (line 30). To avoid computing it twice, move the existing `missileSpeed` computation (line 30) up to replace both. After the change, the early part of `shatterBlock` looks like:

```js
export function shatterBlock(block, missile) {
  if (!block.fragmentTemplate) return;

  const missileSpeed = Math.hypot(missile.vx ?? 0, missile.vy ?? 0, missile.vz ?? 0);
  broadcastSfx("missile_fragments_block", { speed: missileSpeed, x: block.x });

  const template = getTemplate(block.fragmentTemplate);
  if (!template?.fragments || template.fragments.length === 0) {
    deleteBlock(block);
    return;
  }

  const fragIds = [];
  const blockRot = (block.rot ?? 0) * Math.PI / 180;
  const cosR = Math.cos(blockRot);
  const sinR = Math.sin(blockRot);

  const spreadX = getConfig("fragmentSpreadX");
  const spreadY = getConfig("fragmentSpreadY");
  const lifetimeMs = getConfig("fragmentLifetimeMs");

  const missileDir = missileSpeed > 0.01
    ? { x: missile.vx / missileSpeed, y: missile.vy / missileSpeed }
    : { x: 1, y: 0 };
```

The existing line `const missileSpeed = Math.hypot(missile.vx ?? 0, missile.vy ?? 0, missile.vz ?? 0);` that was at line 30 is now removed (it moved to the top of the function).

- [ ] **Step 3: Verify the server starts**

```bash
npm run dev
```

Expected: server starts without errors. Press Ctrl+C.

- [ ] **Step 4: Commit**

```bash
git add server/game/fragmentation.js
git commit -m "feat: emit sfx event on block shatter"
```

---

### Task 8: Create client sound system

**Files:**
- Create: `public/client/sound.js`

This is the largest client-side file. It uses the raw Web Audio API (no Babylon audio).

- [ ] **Step 1: Create `public/client/sound.js`**

```js
const SOUND_CONFIG = {
  masterVolume: 1.0,
  pitchRandomization: 0.2,
  panWorldMinX: -45,
  panWorldMaxX: 45,
  impactSpeedMin: 1.5,
  impactSpeedMax: 24,
  impactVolumeMin: 0.2,
  impactVolumeMax: 1.0,
  cooldownMs: 120,

  effects: {
    trebuchet_release:       { file: "/sounds/trebuchet_release.mp3", volume: 0.75, pitch: 1.0 },
    trebuchet_stretch:       { file: "/sounds/trebuche-stretch.mp3", volume: 0.7, pitch: 1.0 },
    block_hit_ground:        { file: "/sounds/block_hit_ground.mp3", volume: 0.55, pitch: 0.9 },
    block_hit_block:         { file: "/sounds/block-hit-block.mp3", volume: 0.65, pitch: 0.95, cooldownMs: 220 },
    missile_hit_ground:      { file: "/sounds/missile-hit-ground.mp3", volume: 0.55, pitch: 1.0, cooldownMs: 180 },
    missile_hit_block:       { file: "/sounds/missile_hit_block.mp3", volume: 0.65, pitch: 0.98, cooldownMs: 220 },
    missile_hit_missile:     { file: "/sounds/missile-hit-missile.mp3", volume: 0.65, pitch: 1.0 },
    missile_hit_trebuchet:   { file: "/sounds/missile_hit_trebuchet.mp3", volume: 0.8, pitch: 0.92, cooldownMs: 220 },
    missile_fragments_block: { file: "/sounds/missile_fragments_block.mp3", volume: 0.95, pitch: 0.96 },
    missile_crack_block:     { file: "/sounds/missile_crack_block.mp3", volume: 0.75, pitch: 1.0 },
    missile_hits_fragment:   { file: "/sounds/missile_hits_fragment.mp3", volume: 0.7, pitch: 1.04 },
    king_hit:                { file: "/sounds/king_hit.mp3", volume: 1.0, pitch: 1.0 },
    missile_bomb_hit:        { file: "/sounds/missile_bomb-hit.mp3", volume: 1.0, pitch: 0.9 },
  },
};

export function createSoundSystem() {
  let enabled = false;
  let ctx = null;
  let masterGain = null;
  const buffers = new Map();
  const lastPlayedAt = new Map();
  const activeInstances = new Map();

  async function loadAll() {
    if (buffers.size > 0) return;
    const entries = Object.entries(SOUND_CONFIG.effects);
    const results = await Promise.allSettled(
      entries.map(async ([name, cfg]) => {
        const response = await fetch(cfg.file);
        const arrayBuffer = await response.arrayBuffer();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
        buffers.set(name, audioBuffer);
      }),
    );
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === "rejected") {
        console.warn(`Failed to load sound "${entries[i][0]}":`, results[i].reason);
      }
    }
  }

  function ensureContext() {
    if (ctx) return;
    ctx = new AudioContext();
    masterGain = ctx.createGain();
    masterGain.gain.value = SOUND_CONFIG.masterVolume;
    masterGain.connect(ctx.destination);
  }

  function volumeFromSpeed(speed) {
    if (speed == null) return SOUND_CONFIG.impactVolumeMax;
    const t = Math.min(Math.max((speed - SOUND_CONFIG.impactSpeedMin) / (SOUND_CONFIG.impactSpeedMax - SOUND_CONFIG.impactSpeedMin), 0), 1);
    return SOUND_CONFIG.impactVolumeMin + t * (SOUND_CONFIG.impactVolumeMax - SOUND_CONFIG.impactVolumeMin);
  }

  function panFromX(x) {
    const range = SOUND_CONFIG.panWorldMaxX - SOUND_CONFIG.panWorldMinX;
    if (range <= 0) return 0;
    const t = (x - SOUND_CONFIG.panWorldMinX) / range;
    return Math.min(Math.max(t * 2 - 1, -1), 1);
  }

  function isOnCooldown(effectName) {
    const cfg = SOUND_CONFIG.effects[effectName];
    const cd = cfg?.cooldownMs ?? SOUND_CONFIG.cooldownMs;
    const last = lastPlayedAt.get(effectName) ?? 0;
    return (performance.now() - last) < cd;
  }

  function playOneShot(effectName, speed, x) {
    const cfg = SOUND_CONFIG.effects[effectName];
    if (!cfg) return;
    const buffer = buffers.get(effectName);
    if (!buffer) return;
    if (isOnCooldown(effectName)) return;

    lastPlayedAt.set(effectName, performance.now());

    const vol = volumeFromSpeed(speed) * cfg.volume;
    const randomPitch = 1 + (Math.random() - 0.5) * 2 * SOUND_CONFIG.pitchRandomization;
    const rate = cfg.pitch * randomPitch;
    const pan = panFromX(x ?? 0);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;

    const gainNode = ctx.createGain();
    gainNode.gain.value = vol;

    const panNode = ctx.createStereoPanner();
    panNode.pan.value = pan;

    source.connect(gainNode);
    gainNode.connect(panNode);
    panNode.connect(masterGain);

    source.start();
  }

  function startInstance(effectName, instanceId, x) {
    stopInstance(instanceId);

    const cfg = SOUND_CONFIG.effects[effectName];
    if (!cfg) return;
    const buffer = buffers.get(effectName);
    if (!buffer) return;

    const pan = panFromX(x ?? 0);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.playbackRate.value = cfg.pitch;

    const gainNode = ctx.createGain();
    gainNode.gain.value = cfg.volume;

    const panNode = ctx.createStereoPanner();
    panNode.pan.value = pan;

    source.connect(gainNode);
    gainNode.connect(panNode);
    panNode.connect(masterGain);

    source.start();
    activeInstances.set(instanceId, { source, gainNode });
  }

  function stopInstance(instanceId) {
    const instance = activeInstances.get(instanceId);
    if (!instance) return;
    instance.source.stop();
    activeInstances.delete(instanceId);
  }

  function handleSfxEvent(evt) {
    if (!enabled) return;
    if (evt.kind === "sfx") {
      playOneShot(evt.effect, evt.speed, evt.x);
    } else if (evt.kind === "sfxStart") {
      startInstance(evt.effect, evt.instanceId, evt.x);
    } else if (evt.kind === "sfxStop") {
      stopInstance(evt.instanceId);
    }
  }

  async function enable() {
    enabled = true;
    ensureContext();
    if (ctx.state === "suspended") ctx.resume();
    await loadAll();
  }

  function disable() {
    enabled = false;
    for (const instanceId of activeInstances.keys()) {
      stopInstance(instanceId);
    }
  }

  function toggle() {
    if (enabled) {
      disable();
    } else {
      enable();
    }
    return enabled;
  }

  function isEnabled() {
    return enabled;
  }

  return { handleSfxEvent, enable, disable, toggle, isEnabled };
}
```

- [ ] **Step 2: Verify no syntax errors by opening in browser**

Start the server and open the browser console. Navigate to the game page. In the console, run:

```js
import("/client/sound.js").then(m => console.log("loaded", m));
```

Expected: `loaded {createSoundSystem: ƒ}` — no syntax errors.

- [ ] **Step 3: Commit**

```bash
git add public/client/sound.js
git commit -m "feat: add client-side Web Audio sound system"
```

---

### Task 9: Wire up client — network, index, HTML, CSS

**Files:**
- Modify: `public/client/network.js:144-155`
- Modify: `public/client/index.js`
- Modify: `public/client/engine.js`
- Modify: `public/index.html:18`
- Modify: `public/styles.css`

- [ ] **Step 1: Add sfx toggle button to `public/index.html`**

After the `<button id="restart-server" ...>` line (line 18), add:

```html
      <button id="sfx-toggle" type="button" title="Toggle sound effects">SFX</button>
```

The full `<div id="hud">` block becomes:

```html
    <div id="hud">
      <span id="connection">Connecting...</span>
      <span id="player"></span>
      <button id="reset" type="button">Reset</button>
      <button id="restart-server" type="button">Restart Server</button>
      <button id="sfx-toggle" type="button" title="Toggle sound effects">SFX</button>
    </div>
```

- [ ] **Step 2: Add button style to `public/styles.css`**

The `#sfx-toggle` button shares style with `#reset` and `#restart-server`. Add `#sfx-toggle` to the existing selectors. Change:

```css
#reset,
#restart-server {
```

to:

```css
#reset,
#restart-server,
#sfx-toggle {
```

And change:

```css
#reset:hover,
#restart-server:hover {
```

to:

```css
#reset:hover,
#restart-server:hover,
#sfx-toggle:hover {
```

Add an active-state style after the hover rule:

```css
#sfx-toggle.active {
  background: rgb(255 255 255 / 24%);
  border-color: rgb(255 255 255 / 40%);
}
```

- [ ] **Step 3: Export sfxToggleEl from `public/client/engine.js`**

After the existing `export const rematchEl = document.getElementById("rematch");` line, add:

```js
export const sfxToggleEl = document.getElementById("sfx-toggle");
```

- [ ] **Step 4: Route sfx events in `public/client/network.js`**

In the `if (message.type === "event")` block (lines 144-155), add sfx routing inside the `for` loop. After the existing `if (evt.kind === "reset")` block, add:

```js
      if (evt.kind === "sfx" || evt.kind === "sfxStart" || evt.kind === "sfxStop") {
        soundSystem.handleSfxEvent(evt);
      }
```

At the top of the file, import `soundSystem` from a shared reference. The simplest approach: import the `sfxToggleEl` and the `createSoundSystem` function, create the system, and export it. Add to the top of `network.js`:

```js
import { createSoundSystem } from "./sound.js";
import { sfxToggleEl } from "./engine.js";
```

After the existing `let ready = false;` line, add:

```js
const soundSystem = createSoundSystem();

sfxToggleEl.addEventListener("click", () => {
  soundSystem.toggle();
  sfxToggleEl.classList.toggle("active", soundSystem.isEnabled());
});
```

- [ ] **Step 5: Verify end-to-end in browser**

```bash
npm run dev
```

1. Open the game in a browser
2. Click the "SFX" button in the HUD — it should light up (active style)
3. Play the game: aim and fire a trebuchet, hit blocks
4. Listen for sounds on impacts
5. Click "SFX" again to toggle off — sounds should stop
6. Check browser console for any errors

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/styles.css public/client/engine.js public/client/network.js
git commit -m "feat: wire sfx system into client — toggle button, event routing"
```

---

### Task 10: Clean up `public/client/index.js`

**Files:**
- Modify: `public/client/index.js`

No changes needed to `index.js` — the sound system is initialized in `network.js` where the event loop lives, which is already imported. This task is a verification pass.

- [ ] **Step 1: Verify `index.js` imports network.js**

Confirm line 3 of `public/client/index.js` is:

```js
import "./network.js";
```

This side-effect import runs the network module, which creates the sound system and wires up the toggle button.

- [ ] **Step 2: Final end-to-end verification**

```bash
npm run dev
```

Full test checklist in browser:
1. Open the game, two players connected
2. Click SFX to enable
3. Drag a missile into a trebuchet — no sound yet (no drag sfx in spec)
4. Aim (click missile, pull back) — hear trebuchet stretch looping sound
5. Release — stretch stops, release sound plays
6. Missile hits a block — `missile_hit_block` or `missile_crack_block` sound
7. Missile breaks a block — `missile_fragments_block` sound
8. Missile hits ground — `missile_hit_ground` sound
9. Block falls and hits ground — `block_hit_ground` sound
10. Two blocks collide — `block_hit_block` sound
11. Missile hits another missile — `missile_hit_missile` sound
12. Missile hits trebuchet — `missile_hit_trebuchet` sound
13. Missile hits king — `king_hit` sound
14. Toggle SFX off — all sounds stop, no further sounds play
15. Toggle SFX on — sounds resume on next events
16. No console errors throughout

- [ ] **Step 3: Commit (if any fixes were needed)**

```bash
git add -A
git commit -m "fix: address sfx integration issues found during testing"
```

Only commit if changes were made. If everything worked, skip this step.
