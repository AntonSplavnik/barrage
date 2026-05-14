# Complex Object Detection & Convex Hull Shapes

## Context

The `feat/template-based-spawning-design` branch introduced a template registry that pre-loads GLB templates and caches collision bounds at startup. Currently all objects use BOX shapes except missiles (SPHERE). On `main`, kings use CONVEX_HULL from extracted vertex data, and fragment pieces use CONVEX_HULL from fragment template vertex data. This capability was lost in the refactor and needs to be ported into the modular architecture.

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

**Multi-piece template** (auto-detected: multiple Col/ColVis children at top level):

```js
{
  bounds: { halfX, halfY, halfZ, offsetX, offsetY, offsetZ },
  fragments: [
    {
      localX, localY, localZ,
      halfX, halfY, halfZ,
      offsetX, offsetY, offsetZ,
      convexPositions: Float32Array,
    },
    // one entry per Col/ColVis child
  ],
}
```

**Auto-detection**: If a template root has multiple Col/ColVis children at the top level, it is treated as a fragment source and the `fragments` array is populated with per-piece data.

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

### 4. fragmentation.js — Block Breaking

New module `server/game/fragmentation.js` handles block destruction and fragment spawning.

**Trigger**: Game loop detects a block has reached `maxHits` with sufficient missile speed → calls `fragmentBlock(block, missile)`.

**fragmentBlock() flow**:

1. Look up the block's template in the registry (derive template path from object ID).
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

**Fragment visuals**: When client receives `blockBroken` event with `fragIds`:

1. Hide the original block visual.
2. Fragment objects appear in regular state updates (position, rotation).
3. Client creates visuals by cloning the fragment template (single GLB with all pieces).
4. Each fragment's `pieceIndex` (sent by server) tells the client which child mesh to show — all other children in the clone are hidden.
5. Fragment positions sync from server each frame like any other object.

**Shrink and dispose**: When server broadcasts fragment removal:

1. Client plays shrink animation over `fragmentShrinkMs`.
2. Disposes the visual mesh after animation completes.

## Files Affected

| File | Change |
|------|--------|
| `server/game/templateRegistry.js` | Add `convexPositions` extraction, auto-detect multi-piece templates, cache `fragments` array |
| `server/game/physics.js` | Shape-aware body creation, expose `createConvexHullBody` helper |
| `server/game/fragmentation.js` | New module: `fragmentBlock()`, fragment lifecycle management |
| `server/game/level.js` | Pass `shape` from spawn config to game object |
| `server/game/levels/level1.js` | Add `shape` params to kings and missiles spawn calls |
| `public/config.js` | Add fragment config values |
| `public/client/level.js` | Handle `blockBroken` event, `pieceIndex`-based child visibility, shrink animation |
