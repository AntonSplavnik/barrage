# Explosion System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explosion system for bomb-type missiles — area damage, radial force, and chain detonation on collision.

**Architecture:** Introduce a `missileType` field derived at spawn time to distinguish bombs from basic missiles. A new `explosion.js` module handles radial damage/force calculations and chain detonation. `collisions.js` gains an early bomb-detonation check that fires before existing per-target branching, so a bomb detonates on contact with any object type.

**Tech Stack:** Node.js, Babylon.js (Havok physics v2), WebSocket broadcast

**Note:** This codebase has no test framework. Verification steps use server startup checks and manual in-game testing.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `server/config.js` | Modify | Add 4 bomb config values to `SERVER_CONFIG` |
| `server/game/levelRunner.js` | Modify | Derive `missileType` from template path at spawn |
| `server/game/entities.js` | Modify | Include `missileType` in `toWireObject` wire protocol |
| `server/game/explosion.js` | Create | `triggerExplosion()`, `removeBomb()`, damage/force helpers |
| `server/game/collisions.js` | Modify | Early bomb-detonation branch in missile collision handler |

---

### Task 1: Add Bomb Config Values

**Files:**
- Modify: `server/config.js:67` (after `fragmentation: true`)

- [ ] **Step 1: Add config entries**

In `server/config.js`, add these entries to `SERVER_CONFIG` after the `fragmentation: true,` line (line 67):

```javascript
  // Bombs
  bombBlastRadius: 5,
  bombMaxDamage: 3,
  bombMaxForce: 40,
  bombDetonationMinSpeed: 5,
```

These are level-overridable via the existing `getConfig()` mechanism.

- [ ] **Step 2: Verify server starts**

Run: `node server/index.js`
Expected: Server starts without errors.

- [ ] **Step 3: Commit**

```bash
git add server/config.js
git commit -m "feat: add bomb explosion config values"
```

---

### Task 2: Derive missileType at Spawn

**Files:**
- Modify: `server/game/levelRunner.js:116`

- [ ] **Step 1: Add missileType to missile objects**

In `server/game/levelRunner.js`, replace line 116:

```javascript
      ...(isMissileName(id) ? { loadedInto: null } : {}),
```

with:

```javascript
      ...(isMissileName(id) ? {
        loadedInto: null,
        missileType: opts.missileType ?? templatePath.slice("missiles/".length),
      } : {}),
```

The type is derived from the template path by stripping the `missiles/` prefix (e.g. `missiles/bomb` → `"bomb"`, `missiles/basic` → `"basic"`). If `opts.missileType` is passed explicitly, it overrides the derived value — this lets levels decouple visual model from behavior.

- [ ] **Step 2: Verify server starts**

Run: `node server/index.js`
Expected: Server starts without errors. Existing missiles now have `missileType: "basic"` (or whatever their template name is).

- [ ] **Step 3: Commit**

```bash
git add server/game/levelRunner.js
git commit -m "feat: derive missileType from template path at spawn"
```

---

### Task 3: Include missileType in Wire Protocol

**Files:**
- Modify: `server/game/entities.js:21`

- [ ] **Step 1: Add missileType to toWireObject**

In `server/game/entities.js`, in the `toWireObject` function, add this line after line 21 (`...(object.loadedInto ? { loadedInto: object.loadedInto } : {}),`):

```javascript
    ...(object.missileType ? { missileType: object.missileType } : {}),
```

- [ ] **Step 2: Verify server starts**

Run: `node server/index.js`
Expected: Server starts without errors. State broadcasts now include `missileType` on missile objects.

- [ ] **Step 3: Commit**

```bash
git add server/game/entities.js
git commit -m "feat: include missileType in wire protocol"
```

---

### Task 4: Create Explosion Module

**Files:**
- Create: `server/game/explosion.js`

- [ ] **Step 1: Create the explosion module**

Create `server/game/explosion.js`:

```javascript
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { physicsAggregates } from "./physics.js";
import { gameObjects, gameState, dragState } from "./state.js";
import { isMissileName } from "./entities.js";
import { getConfig } from "../config.js";
import { getActiveLevel, getHookContext } from "./modeRunner.js";
import { shatterBlock, deleteBlock } from "./fragmentation.js";
import { broadcast } from "../net/broadcast.js";
import { broadcastSfx } from "./sound.js";

export function removeBomb(bomb) {
  const aggregate = physicsAggregates.get(bomb.id);
  if (aggregate) {
    aggregate.dispose();
    physicsAggregates.delete(bomb.id);
  }
  gameObjects.delete(bomb.id);
  dragState.delete(bomb.id);
}

export function triggerExplosion(bombId, position, config) {
  const { radius, maxDamage, maxForce } = config;
  const pendingDetonations = [];

  for (const object of gameObjects.values()) {
    const dx = object.x - position.x;
    const dy = object.y - position.y;
    const dz = object.z - position.z;
    const distance = Math.hypot(dx, dy, dz);

    if (distance > radius) continue;
    if (object.loadedInto || object.draggedBy || object.removing) continue;

    const strength = 1 - (distance / radius);

    if (object.hitStage !== undefined && object.fragmentTemplate) {
      applyExplosionDamage(object, strength, maxDamage);
    }

    applyExplosionForce(object, position, strength, maxForce);

    if (isMissileName(object.id) && object.missileType === "bomb") {
      pendingDetonations.push(object);
    }
  }

  broadcast({
    type: "event",
    tick: gameState.tick,
    events: [{
      kind: "explosion",
      bombId,
      x: position.x,
      y: position.y,
      z: position.z,
      radius,
    }],
  });

  for (const bomb of pendingDetonations) {
    if (!gameObjects.has(bomb.id)) continue;
    const pos = { x: bomb.x, y: bomb.y, z: bomb.z };
    removeBomb(bomb);
    triggerExplosion(bomb.id, pos, {
      radius: getConfig("bombBlastRadius"),
      maxDamage: getConfig("bombMaxDamage"),
      maxForce: getConfig("bombMaxForce"),
    });
  }
}

function applyExplosionDamage(block, strength, maxDamage) {
  const damage = Math.ceil(maxDamage * strength);
  block.hitStage = (block.hitStage ?? 0) + damage;

  if (getConfig("crackSystem") && block.hitStage < block.maxHits) {
    broadcastSfx("missile_crack_block", { speed: 10, x: block.x });
    broadcast({
      type: "event",
      tick: gameState.tick,
      events: [{ kind: "blockHit", blockId: block.id, hitStage: block.hitStage }],
    });
  } else {
    const hook = getActiveLevel()?.def.hooks?.onBlockDestroyed;
    if (hook) {
      hook(block, null, getHookContext());
    } else if (getConfig("fragmentation")) {
      const syntheticSpeed = getConfig("bombMaxForce") * strength;
      shatterBlock(block, { vx: syntheticSpeed, vy: 0, vz: 0 });
    } else {
      deleteBlock(block);
    }
  }
}

function applyExplosionForce(object, position, strength, maxForce) {
  const aggregate = physicsAggregates.get(object.id);
  if (!aggregate) return;

  const dx = object.x - position.x;
  const dy = object.y - position.y;
  const dist2D = Math.hypot(dx, dy);
  const magnitude = maxForce * strength;

  let impulseX, impulseY;
  if (dist2D < 0.001) {
    impulseX = 0;
    impulseY = magnitude;
  } else {
    impulseX = (dx / dist2D) * magnitude;
    impulseY = (dy / dist2D) * magnitude;
  }

  aggregate.body.applyImpulse(
    new Vector3(impulseX, impulseY, 0),
    aggregate.transformNode.getAbsolutePosition(),
  );
}
```

**Key design decisions:**

- **`removeBomb`** is exported so `collisions.js` can call it to remove the detonating bomb before `triggerExplosion` runs (the bomb must not appear in its own blast radius).
- **`applyExplosionDamage`** follows the same `crackSystem` / `fragmentation` / `onBlockDestroyed` pattern as `handleMissileBlockHit` in `collisions.js`. When calling `shatterBlock`, it passes a synthetic speed derived from `bombMaxForce * strength` so the `"missile_fragments_block"` SFX has audible volume (fragments scatter via `randomSpread` rather than inheriting directional momentum — the synthetic velocity is X-only so the direction fallback `{ x: 1, y: 0 }` in `shatterBlock` applies). When calling `onBlockDestroyed`, it passes `null` for the missile parameter since the damage source is an explosion.
- **`applyExplosionForce`** projects the impulse direction to the XY plane (Z zeroed) since the simulation constrains objects to a plane. Objects at the epicenter (`dist2D < 0.001`) are pushed straight up.
- **Chain detonation** collects bombs into `pendingDetonations` during iteration, then detonates them after the loop completes. Skips bombs already removed from `gameObjects` by a prior chain step. Recurses naturally — a chained bomb's explosion may collect more bombs.

- [ ] **Step 2: Verify server starts**

Run: `node server/index.js`
Expected: Server starts without import errors. The module is not yet wired into collision handling, so no explosions trigger.

- [ ] **Step 3: Commit**

```bash
git add server/game/explosion.js
git commit -m "feat: add explosion module with radial damage, force, and chain detonation"
```

---

### Task 5: Wire Bomb Detonation into Collisions

**Files:**
- Modify: `server/game/collisions.js:8,138-141`

- [ ] **Step 1: Add import**

In `server/game/collisions.js`, add after line 8 (`import { shatterBlock, deleteBlock } from "./fragmentation.js";`):

```javascript
import { triggerExplosion, removeBomb } from "./explosion.js";
```

- [ ] **Step 2: Insert bomb detonation check**

In the `initCollisions` collision handler, insert the bomb detonation check **after** the `missileSpeed` computation (line 140) and **before** the per-target branching that starts at line 142.

After this existing block:

```javascript
      if (!missile) return;

      const missileSpeed = Math.hypot(missile.vx ?? 0, missile.vy ?? 0, missile.vz ?? 0);
```

Insert this block:

```javascript
      if (missile.missileType === "bomb" && !missile.loadedInto && missileSpeed >= getConfig("bombDetonationMinSpeed")) {
        const bombPos = { x: missile.x, y: missile.y, z: missile.z };
        removeBomb(missile);
        triggerExplosion(missile.id, bombPos, {
          radius: getConfig("bombBlastRadius"),
          maxDamage: getConfig("bombMaxDamage"),
          maxForce: getConfig("bombMaxForce"),
        });
        if (other && isMissileName(otherId) && other.missileType === "bomb" && gameObjects.has(otherId)) {
          const otherPos = { x: other.x, y: other.y, z: other.z };
          removeBomb(other);
          triggerExplosion(other.id, otherPos, {
            radius: getConfig("bombBlastRadius"),
            maxDamage: getConfig("bombMaxDamage"),
            maxForce: getConfig("bombMaxForce"),
          });
        }
        return;
      }

      if (missile.missileType === "bomb") return;

      if (other && isMissileName(otherId) && other.missileType === "bomb" && !other.loadedInto) {
        const otherSpeed = Math.hypot(other.vx ?? 0, other.vy ?? 0, other.vz ?? 0);
        if (otherSpeed >= getConfig("bombDetonationMinSpeed")) {
          const otherPos = { x: other.x, y: other.y, z: other.z };
          removeBomb(other);
          triggerExplosion(other.id, otherPos, {
            radius: getConfig("bombBlastRadius"),
            maxDamage: getConfig("bombMaxDamage"),
            maxForce: getConfig("bombMaxForce"),
          });
        }
        return;
      }
```

Three guards handle all bomb scenarios:

1. **First block** — `missile` is a bomb with sufficient speed: detonate it, and also detonate `other` if it's a bomb that survived the first blast. Return.
2. **Second guard** (`missile.missileType === "bomb"` without speed check) — catches slow bombs that fell through the first check. Returns immediately with no effects. This matches the spec: "Below this threshold, the bomb behaves as inert (no detonation, no normal missile effects)."
3. **Third block** — `other` is a bomb (and `missile` is not). This handles the case where both colliding objects are missiles but the collision handler assigned the non-bomb as `missile` (the A/B side assignment from Havok is arbitrary). If the bomb has sufficient speed, detonate it. Either way, return — a non-bomb missile hitting a bomb produces no normal missile effects on either side.

The bomb-on-bomb case (both are bombs): handled by block 1's inner check. Since `missile` is always objA when both are missiles, if objA is a bomb we enter block 1. If objA is basic and objB is a bomb, we skip block 1, skip block 2 (missile isn't a bomb), and enter block 3.

- [ ] **Step 3: Verify server starts**

Run: `node server/index.js`
Expected: Server starts without errors. The full explosion system is now live.

- [ ] **Step 4: Commit**

```bash
git add server/game/collisions.js
git commit -m "feat: wire bomb detonation into collision system"
```

---

### Task 6: Integration Verification

- [ ] **Step 1: Add a bomb missile to a test level**

Temporarily modify an active level's `setup()` function to spawn a bomb. If a `missiles/bomb` template exists in the asset registry, use it directly:

```javascript
spawn("missiles/bomb", { x: -15, y: 5, player: 1 });
```

If no bomb template exists yet, use an existing missile template and override the type:

```javascript
spawn("missiles/basic", { x: -15, y: 5, player: 1, missileType: "bomb" });
```

- [ ] **Step 2: Test basic detonation**

1. Start server: `node server/index.js`
2. Open game in browser
3. Load the bomb into a trebuchet and fire it at a block structure
4. Verify:
   - Bomb disappears on impact (removed from state broadcasts)
   - Client receives `explosion` event (check browser devtools → Network → WS tab)
   - Nearby blocks take damage (crack visuals update or blocks shatter)
   - Nearby objects are pushed away by radial force
   - Force direction is outward from detonation point in XY plane

- [ ] **Step 3: Test inert threshold**

1. Gently release or drop the bomb so it contacts an object at low speed (below `bombDetonationMinSpeed: 5`)
2. Verify: bomb does **not** detonate — no explosion event, bomb remains in game

- [ ] **Step 4: Test chain detonation**

1. Place two bombs near each other (both within blast radius of the other)
2. Fire one bomb at a surface near the other
3. Verify: first bomb detonates, its explosion triggers the second bomb, producing two sequential explosion events

- [ ] **Step 5: Clean up**

Revert the temporary level changes:

```bash
git checkout -- server/game/levels/
```
