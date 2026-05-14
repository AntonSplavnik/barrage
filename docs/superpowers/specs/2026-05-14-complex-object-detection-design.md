# Complex Object Detection & Convex Hull Shapes

## Context

The `feat/template-based-spawning-design` branch introduced a template registry that pre-loads GLB templates and caches collision bounds at startup. Currently all objects use BOX shapes except missiles (SPHERE). On `main`, kings use CONVEX_HULL from extracted vertex data, and fragment pieces use CONVEX_HULL from fragment template vertex data. This capability was lost in the refactor and needs to be ported into the modular architecture.

Additionally, the fragment GLBs (e.g., `fragmented-L.glb`) contain both crack progression stages and shatter pieces in a single file. The system needs to detect and cache both, and support a visual damage progression leading to a final shatter.

## GLB Structure (confirmed from `fragmented-L.glb`)

A fragment-capable block template contains two types of meshes:

**Crack stage meshes** — named `hit{N}-Visual` (one shown at a time as damage progresses):
- `blockL-hit1-Visual` — first hit cracks
- `blockL-hit2-Visual` — second hit cracks
- `blockL-hit3-Visual` — third hit cracks
- `blockL-hit4-Visual` — fourth hit cracks

**Fragment pieces** — named `ColVis.{N}` (each becomes a separate physics object on final shatter):
- `blockL-ColVis.001` through `blockL-ColVis.008` — each with its own translation offset and mesh geometry

## Design

### 1. templateRegistry — Pre-Computation

At startup, `templateRegistry.js` loads each template GLB and caches:

**Regular template** (single Col/ColVis child or multiple that merge into one shape):

```js
{
  bounds: { halfX, halfY, halfZ, offsetX, offsetY, offsetZ },
  convexPositions: Float32Array | null,
  // trebuchet extras if applicable
}
```

**Destructible template** (auto-detected from GLB contents):

```js
{
  bounds: { halfX, halfY, halfZ, offsetX, offsetY, offsetZ },
  convexPositions: Float32Array | null,
  hitStages: ["hit1-Visual", "hit2-Visual", "hit3-Visual", "hit4-Visual"],
  fragments: [
    {
      pieceIndex: 0,
      localX, localY, localZ,
      halfX, halfY, halfZ,
      offsetX, offsetY, offsetZ,
      convexPositions: Float32Array,
    },
    // one entry per ColVis child
  ],
}
```

**Auto-detection**: The registry scans each template's children for two patterns:
- Nodes matching `hit{N}-Visual` → collected into `hitStages` array, sorted by N
- Multiple `ColVis` nodes → collected into `fragments` array with per-piece vertex data

If either pattern is found, the template is marked as destructible. `hitStages` drives the crack progression; `fragments` drives the final shatter. A template may have stages without fragments (just cracks, then disappears) or fragments without stages (shatters immediately on final hit).

**Vertex extraction**: For every template, `convexPositions` is extracted using the same approach as `main`'s `extractConvexPositions()` — reads vertex positions from collider meshes, transforms into root-local space, stores as `Float32Array`. This is cheap at startup. Whether it is used depends on the `shape` param at spawn time.

### 2. spawn() — Explicit Shape Selection

The level config's `spawn()` call accepts an optional `shape` parameter:

```js
spawn("kings/default-L",     { x: -37, y: 1.05, player: 1, shape: "convex_hull" });
spawn("missiles/basic",      { x: 0, y: 0.5, shape: "sphere" });
spawn("blocks/defarult-L",   { x: -12, y: 1 });                    // defaults to "box"
spawn("blocks/fragmented-L", { x: 12, y: 1 });                     // regular block, box shape
```

Valid values: `"box"` (default), `"sphere"`, `"convex_hull"`.

The shape string is stored on the game object and passed through to `physics.js` when creating the body. The fragmented block itself (before it breaks) is a normal block with whatever shape the spawn specifies. The `fragments` array in the registry is separate from the block's own shape.

### 3. physics.js — Shape-Aware Body Creation

`createPhysicsBodies()` selects shape type based on the game object's `shape` field:

- `"convex_hull"` + `convexPositions` available → create `Mesh` with `VertexData` from cached positions, `PhysicsAggregate` with `CONVEX_HULL`. Falls back to BOX with warning if no vertex data.
- `"sphere"` → `TransformNode`, `PhysicsAggregate` with `SPHERE` (radius from max half-extent).
- `"box"` (default) → `TransformNode`, `PhysicsAggregate` with `BOX` (extents + center from cached bounds).

Convex hull mesh creation follows `main`'s pattern: create `Mesh`, apply `VertexData` with positions + fan triangle indices, compute world matrix, pass to `PhysicsAggregate`.

A shared helper is exposed for reuse:

```js
export function createConvexHullBody(id, positions, position, rotation, physicsOptions)
```

Used by both `createPhysicsBodies()` (for kings, etc.) and `fragmentation.js` (for fragment pieces).

Arena colliders are unchanged — AABB boxes via `createArenaColliders()`.

### 4. Damage Progression & Fragmentation

Block destruction is a level-driven behavior, triggered via the `hooks` system in the level config.

#### 4a. Crack Progression (visual damage stages)

Each hit on a destructible block advances its `hitStage`. The server tracks the current stage and broadcasts it. The client swaps the visible mesh:

1. Block starts showing its base mesh (from the block's own template, e.g., `defarult-L.glb`)
2. Hit 1 → server sets `hitStage: 1`, client swaps to `hit1-Visual` from the fragment template
3. Hit 2 → `hitStage: 2`, client swaps to `hit2-Visual`
4. Hit 3 → `hitStage: 3`, client swaps to `hit3-Visual`
5. Hit 4 → `hitStage: 4`, client swaps to `hit4-Visual`
6. Final hit → shatter (see 4b)

The number of stages is determined by the GLB contents (how many `hit{N}-Visual` nodes exist). `maxHits` on the game object equals the number of stages + 1 (the final hit triggers the shatter).

The block's physics shape does NOT change during crack progression — only the visual swaps on the client.

#### 4b. Fragmentation (final shatter)

New module `server/game/fragmentation.js` provides the shatter capability. It is invoked by the level's hook, not hardcoded into the game loop.

**Level hook**:

```js
// level1.js
hooks: {
  onBlockDestroyed(block, missile, ctx) {
    ctx.shatterBlock(block, missile);
  },
},
```

The game loop detects "block reached maxHits with sufficient missile speed" and calls the level's `onBlockDestroyed` hook. The hook decides what to do — calling `ctx.shatterBlock()` is one option, but a level could also just delete the block, spawn something else, etc.

**shatterBlock() flow**:

1. Look up the block's fragment template in the registry (derive template path from object ID, or a configured `fragmentTemplate` field on the block).
2. Check if template has a `fragments` array — if not, just delete the block.
3. For each fragment piece in the cached array:
   - Calculate world position: block position + piece's `localX/Y/Z` rotated by block's current rotation.
   - Calculate spread velocity: missile impact velocity (scaled) + random scatter.
   - Create a game object with `isFragment: true`, `parentBlockId`, `createdTick`, `pieceIndex`.
   - Create a `CONVEX_HULL` physics body via `createConvexHullBody()` using piece's cached `convexPositions`.
   - Apply linear velocity + random angular velocity.
4. Delete the original block (game object + physics body).
5. Broadcast `blockBroken` event with `fragIds` to clients.

**Fragment lifecycle**:

- Fragments are live physics objects that collide with everything.
- After `fragmentLifetimeMs` (configurable), server marks them for removal.
- Two-phase removal: broadcast removal event on tick N, dispose physics on tick N+1.
- Client plays shrink animation on receiving the event.

**Config values** (exposed in `BARRAGE_CONFIG` for tweaking):

| Key | Description | Default (from main) |
|-----|-------------|---------------------|
| `fragmentLifetimeMs` | How long fragments live as physics objects | new, needs tuning |
| `fragmentSpreadX` | Max horizontal velocity scatter | 4 |
| `fragmentSpreadY` | Max vertical velocity scatter | 2 |
| `fragmentShrinkMs` | Client shrink animation duration | 500 |
| `fragmentImmunityMs` | Protection period before fragments can be hit | 500 |

### 5. Client-Side Handling

The client does not need shape awareness — that is server-only physics.

**Crack progression**: On each state update, the client reads the block's `hitStage` field:
- If `hitStage` is 0 or absent, show the block's own base mesh
- If `hitStage` >= 1, clone the fragment template (if not already cloned), hide all children except `hit{N}-Visual` matching the current stage
- The base block mesh is hidden when a crack stage is active

**Fragment visuals**: When client receives `blockBroken` event with `fragIds`:

1. Hide the block visual (including any active crack stage mesh).
2. Fragment objects appear in regular state updates (position, rotation).
3. Client creates visuals by cloning the fragment template (single GLB with all pieces).
4. Each fragment's `pieceIndex` (sent by server) tells the client which ColVis child mesh to show — all other children (other ColVis pieces + all hit-Visual stages) are hidden.
5. Fragment positions sync from server each frame like any other object.

**Shrink and dispose**: When server broadcasts fragment removal:

1. Client plays shrink animation over `fragmentShrinkMs`.
2. Disposes the visual mesh after animation completes.

### 6. Linking Block to Fragment Template

A block spawned from `blocks/defarult-L` needs to know its fragment source is `blocks/fragmented-L`. This link is specified in the spawn call:

```js
spawn("blocks/defarult-L", { x: -12, y: 1, fragmentTemplate: "blocks/fragmented-L" });
```

If `fragmentTemplate` is not set, the block is not destructible (no crack stages, no shattering). The `hitStages` and `fragments` data come from the fragment template, not the block's own template.

This keeps the block mesh (clean geometry) separate from the damage/fragment mesh (cracks + pieces), which matches the current GLB organization.

## Files Affected

| File | Change |
|------|--------|
| `server/game/templateRegistry.js` | Add `convexPositions` extraction, auto-detect `hitStages` and `fragments` from GLB node names, cache per-piece vertex data |
| `server/game/physics.js` | Shape-aware body creation, expose `createConvexHullBody` helper |
| `server/game/fragmentation.js` | New module: `shatterBlock()` capability, fragment lifecycle management |
| `server/game/level.js` | Pass `shape` and `fragmentTemplate` from spawn config to game object, wire up level hooks |
| `server/game/levels/level1.js` | Add `shape` params, `fragmentTemplate` links, `onBlockDestroyed` hook |
| `public/config.js` | Add fragment config values |
| `public/client/level.js` | Handle crack stage swapping, `blockBroken` event, `pieceIndex`-based child visibility, shrink animation |
