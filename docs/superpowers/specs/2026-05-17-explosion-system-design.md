# Explosion System Design

## Overview

Add an explosion system for bomb-type missiles. When a bomb collides with any object, it detonates — applying area damage and force to all nearby dynamic objects, then removing itself.

## Missile Type System

### Type Assignment

At spawn time in `levelRunner.js`, derive `missileType` from the template path:

- `missiles/bomb_0` → `missileType: "bomb"`
- `missiles/basic_0` → `missileType: "basic"`

The type is extracted from the template path by stripping the `missiles/` prefix (e.g. template path `missiles/bomb` → `"bomb"`).

If `opts.missileType` is passed explicitly to `spawn()`, it overrides the derived value. This allows levels to decouple visual model from behavior (e.g. a basic-looking missile that explodes).

### Wire Protocol

`toWireObject` in `entities.js` includes `missileType` so the client knows which behavior/VFX to use.

## Explosion Module

New file: `server/game/explosion.js`

### API

```js
triggerExplosion(bombId, position, config) → void
```

**Parameters:**
- `bombId: string` — ID of the detonating missile (included in the client event)
- `position: { x, y, z }` — detonation point
- `config: { radius, maxDamage, maxForce }` — explosion properties

### Behavior

1. Iterate all `gameObjects`
2. For each object, compute distance from detonation point to object center
3. Skip if distance > radius
4. Skip if object is inert to explosions: `loadedInto` set, `draggedBy` set, or `removing` is true
5. Compute falloff: `strength = 1 - (distance / radius)` (linear, 1.0 at center, 0.0 at edge)
6. **Damage**: if object has `hitStage` (blocks with `fragmentTemplate`), apply damage using the same `crackSystem` check as `handleMissileBlockHit`:
   - If `getConfig("crackSystem")` is true: increment `hitStage` by `Math.ceil(maxDamage * strength)`. If `hitStage < maxHits`, broadcast `{ kind: "blockHit", blockId, hitStage }` so the client updates crack visuals. If `hitStage >= maxHits`, destroy the block.
   - If `crackSystem` is false: destroy the block immediately (any hit is lethal, matching existing missile behavior).
   - Destruction path: call the `onBlockDestroyed` hook if the active level defines one, otherwise shatter or delete (same as `handleMissileBlockHit`).
   - Kings are not damaged — they are defeated only by being knocked over (rotation > 45°), so only force applies to them.
7. **Force**: get object's Havok physics body and apply impulse — direction is normalized vector from detonation point to object center **projected to the XY plane** (Z is zeroed by the simulation's plane constraint), magnitude = `maxForce * strength`
8. **Chain detonation**: if object is a bomb (`missileType === "bomb"`), collect it into a pending detonation list (don't detonate inline — the `gameObjects` iteration must finish first)
9. **Broadcast**: send explosion event to clients
10. After iteration, detonate each bomb in the pending list (remove it, call `triggerExplosion` at its position). This recurses naturally — a chained bomb's explosion may collect more bombs. Skip bombs already removed from `gameObjects` (destroyed by a prior chain step).

### Affected Objects

- **Force** applies to all dynamic objects in radius (blocks, missiles, fragments, kings)
- **Skip**: objects with `loadedInto` set (velocity zeroed every tick), `draggedBy` set (position force-synced), or `removing` true (physics shape is trigger)
- **Damage** (hitStage increment) only applies to objects that have `hitStage` (blocks with `fragmentTemplate`). Kings are force-only — their defeat condition is rotation > 45°, not hit count.

## Collision Integration

In `collisions.js`, add a bomb detonation check **early** in the missile collision section (before per-target branching), so a bomb detonates on contact with any object type (block, ground, king, trebuchet, fragment, or another missile):

1. After the `if (!missile) return` guard and `loadedInto` check, compute missile speed
2. If `missile.missileType === "bomb"` and speed >= `getConfig("bombDetonationMinSpeed")`: detonate
3. Remove the bomb **first**: dispose Havok aggregate, delete from `gameObjects`, clear from `dragState` if present — this must happen before `triggerExplosion` so the bomb doesn't find itself in its own blast radius
4. Call `triggerExplosion()` at the bomb's position with bomb config values
5. **Bomb-on-bomb**: if `other` is also a missile with `missileType === "bomb"` and it still exists in `gameObjects`, remove it (same as step 3), then detonate it (same as step 4)
6. Return — skip all per-target handling

Below this threshold, the bomb behaves as inert (no detonation, no normal missile effects). Regular missiles (`missileType: "basic"`) skip this check entirely and continue with existing behavior unchanged.

Future missile types (shrapnel, etc.) add their own branch in the same early section.

## Config

New entries in `SERVER_CONFIG` (level-overridable via `getConfig()`):

```
bombBlastRadius: 5
bombMaxDamage: 3
bombMaxForce: 40
bombDetonationMinSpeed: 5
```

## Client Event

Broadcast on detonation:

```json
{
  "type": "event",
  "tick": "<current tick>",
  "events": [{
    "kind": "explosion",
    "bombId": "<missile id>",
    "x": "<detonation x>",
    "y": "<detonation y>",
    "z": "<detonation z>",
    "radius": "<blast radius>"
  }]
}
```

Client uses this to render VFX (particles, flash, shockwave) and remove the bomb mesh.

## Bomb Removal

On detonation:
- Dispose the Havok physics aggregate via `physicsAggregates`
- Delete from `gameObjects` map
- Clear from `dragState` if the bomb was being dragged
- Client removes the mesh upon receiving the explosion event

## Damage Falloff Example

With `bombBlastRadius: 5` and `bombMaxDamage: 3`:

| Distance | Strength | Damage dealt |
|----------|----------|-------------|
| 0        | 1.0      | 3 hits      |
| 1        | 0.8      | 3 hits      |
| 2.5      | 0.5      | 2 hits      |
| 4        | 0.2      | 1 hit       |
| 5+       | 0        | none        |

## Force Falloff Example

With `bombMaxForce: 40`:

| Distance | Strength | Impulse magnitude |
|----------|----------|------------------|
| 0        | 1.0      | 40               |
| 2.5      | 0.5      | 20               |
| 5+       | 0        | none             |

## Files Changed

- `server/game/explosion.js` — new module
- `server/game/collisions.js` — bomb type branch
- `server/game/levelRunner.js` — derive/assign `missileType` at spawn
- `server/game/entities.js` — include `missileType` in `toWireObject`
- `server/config.js` — add bomb config values
