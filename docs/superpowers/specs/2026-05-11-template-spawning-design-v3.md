# Template-Based Object Spawning System

Replaces the monolithic GLB parsing approach with separate template GLBs per object variant and JSON level configs that define what to spawn and where.

## Problem

The current system loads a single GLB per level containing all gameplay objects (blocks, missiles, trebuchets, kings) and static environment together. The server reverse-engineers game objects by scanning mesh names. Any change to the Blender export structure (nesting, naming, node types) breaks the parser. Adding or repositioning objects requires a Blender re-export.

## File Structure

```
public/assets/
├── levels/
│   ├── level1.glb            # Static arena: ground, barriers, lights, camera, decorations
│   ├── level1.json           # Gameplay object spawn list
│   ├── level2.glb
│   └── level2.json
└── templates/
    ├── blocks/
    │   └── wood.glb           # One block: visual + collider children
    ├── missiles/
    │   └── basic.glb          # One missile: visual + collider children
    ├── trebuchets/
    │   └── basic.glb          # Full hierarchy: body, arm, load target
    └── kings/
        └── default.glb        # King: visual + collider children
```

### Level Config Format

Each level has a JSON file listing objects to spawn:

```json
{
  "objects": [
    { "template": "trebuchets/basic", "x": -25, "y": 1, "z": 0, "player": 1 },
    { "template": "trebuchets/basic", "x": 25, "y": 1, "z": 0, "player": 2 },
    { "template": "kings/default", "x": -37, "y": 1.05, "z": 0, "player": 1 },
    { "template": "kings/default", "x": 37, "y": 1.05, "z": 0, "player": 2 },
    { "template": "blocks/wood", "x": -12, "y": 1, "z": 0 },
    { "template": "blocks/wood", "x": -12, "y": 9, "z": 0 },
    { "template": "blocks/wood", "x": 12, "y": 1, "z": 0 },
    { "template": "blocks/wood", "x": 12, "y": 9, "z": 0 },
    { "template": "missiles/basic", "x": 0, "y": 0.5, "z": 0 },
    { "template": "missiles/basic", "x": 0, "y": 6, "z": 0 }
  ]
}
```

**Field reference:**

| Field | Required | Type | Description |
|---|---|---|---|
| `template` | yes | string | Path under `templates/` (without `.glb` extension) |
| `x`, `y`, `z` | yes | number | Spawn position in world coordinates |
| `player` | trebuchets, kings | `1` or `2` | Owning player. Required for trebuchets and kings. Omit for shared objects (blocks, missiles) |

Additional per-instance properties (scale, rotation, color) can be added later without changing the architecture.

### Player Ownership

The current system uses three inconsistent mechanisms to determine which player owns an object:

1. **Connection order** — first WebSocket connection = player 1 (`client.id = 1`), second = player 2
2. **Object name** — `isLeftSideTrebuchetName()` checks for `"p1"`, `"left"`, or `"1"` substrings in the name to determine trebuchet side, fire direction, and drag bounds
3. **Object position** — `originX < 0` determines which player's king was knocked out; `object.x > 2` / `object.x < -2` gates drag permissions for non-trebuchet objects

The template system eliminates mechanism 2 (object names no longer carry player info). Mechanism 3 is fragile — it breaks for asymmetric levels and encodes a gameplay rule in an implicit spatial assumption.

The `player` field in the level config replaces both mechanisms 2 and 3 for objects that have a fixed owner. It becomes the single source of truth for:

- **Trebuchet fire direction** — `player === 1` fires right (sideSign = 1), `player === 2` fires left (sideSign = -1)
- **Trebuchet drag bounds** — `player === 1` clamped to `[trebuchetLeftMinX, trebuchetLeftMaxX]`, `player === 2` to `[trebuchetRightMinX, trebuchetRightMaxX]`
- **Trebuchet drag permission** — only the owning player can drag a trebuchet (currently unenforced, a pre-existing bug)
- **Trebuchet aim permission** — only the owning player can aim a trebuchet (currently unenforced, a pre-existing bug)
- **King knockout attribution** — when a king is knocked out, `king.player` identifies the loser directly
- **Aim arrow direction (client)** — the client uses `player` to determine which direction is "forward" for the aim arrow visual

Blocks and missiles have no `player` field. They are shared objects — any player can interact with them subject to the existing position-based drag check (`client.id === 1 && object.x > 2` blocks P1 from dragging objects on the right side). This allows objects knocked across the midline to become available to the other player, which is intentional gameplay.

#### Server-side changes (detailed)

**`server/utils.js` — replace name-based side detection:**

`isLeftSideTrebuchetName(name)` and `sideSignForTrebuchet(name)` are removed entirely. They are replaced by direct reads from the gameObject's `player` field:

| Current code | Location | Replacement |
|---|---|---|
| `sideSignForTrebuchet(trebuchet.id)` | `trebuchet.js:120` — fire direction | `trebuchet.player === 1 ? 1 : -1` |
| `isLeftSideTrebuchetName(object.id)` for `minX`/`maxX` | `utils.js:170-175` — drag bounds in `constrainedPointForObject()` | `object.player === 1` checks against `trebuchetLeftMinX`/`trebuchetLeftMaxX`, otherwise `trebuchetRightMinX`/`trebuchetRightMaxX` |

**`server/trebuchet.js` — fire direction:**

```js
// Before (broken with template IDs):
const shotDirectionX = sideSignForTrebuchet(trebuchet.id);

// After:
const shotDirectionX = trebuchet.player === 1 ? 1 : -1;
```

**`server/input.js` — add trebuchet ownership checks:**

The current code has no ownership validation on `dragStart` or `aimStart` for trebuchets — any connected player can drag or aim any trebuchet. These are pre-existing bugs that become critical with template IDs (no name to even accidentally filter on).

`dragStart` handler — add a guard after the `isTrebuchetName` check (line 115), before setting `draggedBy`:

```js
// Before (no ownership check for trebuchets):
if (!isTrebuchetName(object.id)) {
  if (client.id === 1 && object.x > 2) return;
  if (client.id === 2 && object.x < -2) return;
}

// After:
if (isTrebuchetName(object.id)) {
  if (object.player && object.player !== client.id) return;
} else {
  if (client.id === 1 && object.x > 2) return;
  if (client.id === 2 && object.x < -2) return;
}
```

`aimStart` handler — add a guard after finding the trebuchet via `missile.loadedInto` (line 133), before setting `fireState`:

```js
if (trebuchet.player && trebuchet.player !== client.id) return;
```

Both checks ensure player 1 cannot drag or aim player 2's trebuchet and vice versa. The checks are skipped if `player` is null (defensive, should not happen for trebuchets).

**`server/gameManager.js` — king knockout attribution:**

```js
// Before (position-based):
export function playerIdForKing(king) {
  return king.originX < 0 ? "P1" : "P2";
}

// After (explicit):
export function playerIdForKing(king) {
  return king.player === 1 ? "P1" : "P2";
}
```

#### Client-side changes (detailed)

**`public/client/utils.js` — replace `isLeftSideTrebuchetName`:**

The client needs the `player` value to determine the aim arrow pull direction. It receives this from the `player` field on the state message (see Network Protocol below).

```js
// Before:
export function isForwardPullPoint(trebuchetId, point, releasePoint) {
  if (isLeftSideTrebuchetName(trebuchetId)) {
    return point.x > releasePoint.x;
  }
  return point.x < releasePoint.x;
}

// After:
export function isForwardPullPoint(trebuchetState, point, releasePoint) {
  if (trebuchetState.player === 1) {
    return point.x > releasePoint.x;
  }
  return point.x < releasePoint.x;
}
```

The caller in `aim.js` (`updateAimArrow`) already has access to `latestObjectStates` and looks up the trebuchet by ID. It passes the full trebuchet state object instead of just the ID string.

**`public/client/aim.js` — update `updateAimArrow` call site:**

```js
// Before:
if (!isForwardPullPoint(trebuchetId, aimWorldPoint, headPoint)) {

// After:
const trebuchetState = latestObjectStates.get(trebuchetId);
if (!trebuchetState || !isForwardPullPoint(trebuchetState, aimWorldPoint, headPoint)) {
```

`isLeftSideTrebuchetName` is removed from `public/client/utils.js` entirely.

**`public/client/utils.js` — `isDraggableRoot()` continues to work without changes:**

The current client-side function determines which objects are draggable:

```js
export function isDraggableRoot(root) {
  const name = root.name.toLowerCase();
  return name.includes("block")
    || name.includes("trebuche")
    || name.includes("missile");
}
```

With the template system, clone root nodes are registered in `visualObjects` by their generated ID (e.g., `trebuchets/basic_0`). The `findGameplayRoot()` function in `state.js` walks the node hierarchy checking `visualObjects.has(current.name)`, so clone root names must match the generated IDs. This means `isDraggableRoot` receives names like `"trebuchets/basic_0"`, `"blocks/wood_1"`, `"missiles/basic_0"`. These contain `"trebuche"`, `"block"`, and `"missile"` respectively, so the existing substring checks still match. Kings (`"kings/default_0"`) are correctly excluded — `"king"` is not in the check list.

This is coincidental but reliable: template folder names are a naming convention we control, and the substrings are stable. No change needed.

#### Spawning — storing the player field

When the server spawns objects from the level config, the `player` field is copied directly onto the gameObject:

```js
// In the spawning loop (server/level.js):
const entry = config.objects[i];
const gameObject = {
  id: generatedId,
  x: entry.x,
  y: entry.y,
  z: entry.z,
  // ... physics properties from template ...
  player: entry.player ?? null,  // null for blocks, missiles
};
```

The `player` field is a plain integer (1 or 2) or null. It does not change during gameplay — it is set once at spawn time and persists until the level is cleared.

### Template GLB Internal Structure

Templates use the same child naming conventions that exist today:

- **Visual mesh:** name contains "Visual" or "Vis" — rendered, casts shadows
- **Collider mesh:** name contains "Collider" or "Col" — hidden on client, used for physics bounds
- **ColVis mesh:** name contains "ColVis" — serves both roles
- **Trebuchet arm:** name contains "arm" — rotatable sub-hierarchy
- **Missile load target:** name contains "missile-load-target" — position marker inside arm

Fragments for block destruction can be included as hidden children in the block GLB. The spawning system will ignore them; fragmentation logic will use them when implemented later.

### Object ID Format

Each spawned object gets a unique ID: `"{template}_{index}"`.

The index is per-template, incrementing from 0 in level config order. Examples:

- Config has 4 `blocks/wood` entries → `blocks/wood_0`, `blocks/wood_1`, `blocks/wood_2`, `blocks/wood_3`
- Config has 2 `trebuchets/basic` entries → `trebuchets/basic_0`, `trebuchets/basic_1`
- Config has 1 `missiles/basic` entry → `missiles/basic_0`

**Parsing rule:** split on the last `_` character. Left part = template path, right part = numeric index. Template paths may contain underscores (e.g., `blocks/dark_wood_3` → template = `blocks/dark_wood`, index = `3`).

The template path prefix determines the object type, replacing all name-parsing heuristics (`isDynamicName`, `isMissileName`, etc.):
- `trebuchets/` prefix → trebuchet type
- `missiles/` prefix → missile type
- `blocks/` prefix → block type
- `kings/` prefix → king type

## Architecture

### Template Registry

A module on both server and client that loads all template GLBs once at startup and keeps them in memory for the server's lifetime.

**Server (`server/templateRegistry.js`):**
- Scans `public/assets/templates/` recursively for `.glb` files
- Loads each **sequentially** into the Babylon scene via `SceneLoader.AppendAsync`. After each load, immediately renames the new `__root__` node to `__template_{templatePath}__` before loading the next template. This prevents ambiguity — each `AppendAsync` creates a `__root__` node, so the rename must happen before the next load introduces another one:

```js
for (const templatePath of templatePaths) {
  const before = new Set(scene.rootNodes);
  await SceneLoader.AppendAsync(baseUrl, `${templatePath}.glb`, scene);
  const newRoot = scene.rootNodes.find((n) => !before.has(n));
  newRoot.name = `__template_${templatePath}__`;
  // ... extract data from newRoot's hierarchy ...
}
```

- Extracts and caches per template:
  - Collider bounds (halfX/Y/Z, offsetX/Y/Z) from Col/ColVis children
  - Physics shape type (sphere for missiles, box for everything else)
  - Damping values (higher for trebuchets)
- For trebuchet templates: also stores references to the root node, arm node, and missile-load-target node in the cached data. All three nodes stay alive in the scene for runtime load target computation (see Load Target Computation below)
- Hides all template root nodes (not rendered, server is headless anyway)
- Stores in a `Map<templatePath, TemplateData>`
- Templates are never disposed — they persist across level transitions

**Client (`public/client/templateRegistry.js`):**
- Loads each template GLB into the scene
- Hides the root node (template is not rendered directly)
- Caches the root node for cloning
- Stores in a `Map<templatePath, TemplateNode>`
- Templates are never disposed — they persist across level transitions

### Load Target Computation

The server computes the missile load target position every tick for loaded missiles. This position depends on the trebuchet's current world position and arm angle — the load target traces an arc as the arm rotates during aiming and firing.

**Current system (`server/trebuchet.js:16-48`):**

`loadTargetForTrebuchet(trebuchet)` looks up a `loadTargets` entry containing three Babylon scene nodes — `rootNode` (trebuchet body), `armNode` (rotating arm), and `targetNode` (missile seat on the arm). It repositions `rootNode` to the trebuchet's current position, rotates `armNode` to the current arm angle, calls `computeWorldMatrix(true)` on all three, and reads `targetNode.getAbsolutePosition()` to get the world-space result.

This function already handles shared nodes — it repositions the same set of nodes for each trebuchet before computing. Multiple trebuchet instances can share one set of template nodes without conflict.

**Template system — what changes:**

The nodes now come from the template GLB (`trebuchets/basic.glb`) instead of the monolithic level GLB. The template registry keeps these nodes alive in the scene. During level spawning, when a trebuchet instance is created, the spawning code registers a `loadTargets` entry for that instance's ID, pointing to the template's arm and target nodes:

```js
// In the spawning loop, for each trebuchet instance:
const templateData = templateRegistry.get("trebuchets/basic");
loadTargets.set(generatedId, {
  targetNode: templateData.targetNode,
  rootNode: templateData.rootNode,
  armNode: templateData.armNode,
  offsetX: templateData.loadTargetOffsetX,
  offsetY: templateData.loadTargetOffsetY,
  offsetZ: templateData.loadTargetOffsetZ,
});
```

Multiple trebuchet instances (e.g., `trebuchets/basic_0` and `trebuchets/basic_1`) point to the same template nodes. This works because `loadTargetForTrebuchet` repositions the nodes to each trebuchet's state before computing — it never reads stale state from a previous call.

**`loadTargetForTrebuchet()` itself is unchanged.** It reads from `loadTargets`, positions nodes, computes world matrices, returns coordinates — exactly as it does today. The only difference is what populates `loadTargets` (template registry instead of `registerMeshRoots`).

Note: the current code has a `loadTargets.get("default")` fallback (populated by `registerMeshRoots` at `level.js:103`). With template-based spawning, every trebuchet instance gets an explicit `loadTargets` entry keyed by its generated ID, so the `"default"` key is no longer populated. The fallback chain in `loadTargetForTrebuchet` (`loadTargets.get(trebuchet.id) ?? loadTargets.get("default")`) still works — the primary lookup succeeds, making the `"default"` branch dead code. It can be removed for clarity during implementation.

### Spawning Flow

#### Level Load (server)

1. Read level JSON config
2. Load arena GLB into scene (static environment)
3. For each object in config:
   a. Look up cached template data by `template` field
   b. Generate unique ID: `"{template}_{counter}"` (counter is per-template)
   c. Create gameObject entry with position from config + physics properties from template + `player` from config (null if absent)
   d. For trebuchets: register `loadTargets` entry pointing to the template's arm/target nodes
   e. Create Havok physics body via existing `createPhysicsBodies()` logic
4. Start simulation, broadcast state to clients

#### Level Load (client)

1. Receive arena GLB URL from server (in welcome, roundStarted, or matchReset message)
2. Load arena GLB (environment visuals, camera, lights)
3. On first state message containing objects:
   a. For each object ID not yet in `visualObjects`:
      - Extract template path from ID (everything before last `_`)
      - Clone the cached template node
      - Position at coordinates from state message
      - Register in `visualObjects`, `visualBaseRotations`
      - For trebuchets: register arm nodes and load targets from the clone
   b. Set up shadows
4. Subsequent state messages update positions/rotations as usual via `applyState()`

#### Level Transition

**Server:** `clearScene()` is updated to preserve template nodes:

```js
function clearScene() {
  for (const [, aggregate] of physicsAggregates) {
    aggregate.dispose();
  }
  physicsAggregates.clear();
  gameObjects.clear();
  loadTargets.clear();      // cleared — re-populated on next level spawn
  dragState.clear();         // NEW — not in current clearScene(), fixes stale drag refs across level transitions

  // Only dispose arena root nodes, not template root nodes
  const arenaRoots = scene.rootNodes.filter((n) => n.name === "__root__");
  for (const root of arenaRoots) {
    root.dispose(false, true);
  }
}
```

The current `clearScene()` disposes all nodes named `__root__` and clears `physicsAggregates`, `gameObjects`, and `loadTargets`. Two changes:

1. Template nodes are renamed to `__template_{path}__` during registry init, so the `__root__` filter excludes them.
2. `dragState.clear()` is added — the current code does not clear drag state during level transitions (only during within-level resets in `resetGameState()`). This is a bug fix: without it, stale drag references from the previous level could persist.

`loadTargets` is cleared because the old trebuchet instance IDs no longer exist — it will be re-populated with new instance IDs when the next level spawns trebuchets.

**Client:** `clearLevel()` disposes cloned instances and arena visuals. Template root nodes (hidden, used only for cloning) are not disposed.

Templates are NOT reloaded — they persist across levels on both server and client.

### Type Detection

Current name-based functions are replaced with ID prefix checks:

| Current | New |
|---|---|
| `isDynamicName(name)` | All template-spawned objects are dynamic |
| `isTrebuchetName(name)` | `id.startsWith("trebuchets/")` |
| `isMissileName(name)` | `id.startsWith("missiles/")` |
| `isKingName(name)` | `id.startsWith("kings/")` |
| `isBlockName(name)` | `id.startsWith("blocks/")` |
| `isLeftSideTrebuchetName(name)` | **Removed.** Replaced by `object.player === 1` |
| `sideSignForTrebuchet(name)` | **Removed.** Replaced by `object.player === 1 ? 1 : -1` |

These are updated in `server/utils.js` and `public/client/utils.js`. The type-check functions (`isTrebuchetName`, etc.) keep the same names and signatures for minimal downstream changes. The side-detection functions (`isLeftSideTrebuchetName`, `sideSignForTrebuchet`) are removed — their callers are updated to read `object.player` directly.

## Network Protocol

No new message types. Changes to existing messages:

- **welcome:** `level` field changes from `"/assets/level1.glb"` to `"/assets/levels/level1.glb"`
- **state:** the `player` field is included on trebuchet and king objects (see below)
- **roundStarted:** `level` field updated to new path
- **matchReset:** `level` field updated to new path

### State message — player field

`toWireObject()` in `server/utils.js` is updated to include `player` when present:

```js
export function toWireObject(object) {
  return {
    id: object.id,
    x: object.x,
    y: object.y,
    z: object.z,
    rot: object.rot,
    vx: object.vx,
    vy: object.vy,
    vz: object.vz,
    ...(object.player != null ? { player: object.player } : {}),
    ...(object.loaded !== undefined ? { loaded: object.loaded } : {}),
    ...(object.loadedInto ? { loadedInto: object.loadedInto } : {}),
    ...(object.armAngle !== undefined ? { armAngle: object.armAngle, fireState: object.fireState } : {}),
    ...(object.hits !== undefined ? { hits: object.hits, maxHits: object.maxHits } : {}),
  };
}
```

This adds one integer field to trebuchet and king objects in each state tick. Blocks and missiles have `player: null` which is omitted from the wire format. The client reads `player` from `latestObjectStates` for aim arrow direction — no separate API call needed.

The client does not fetch level JSON configs. The server is the sole authority on what objects exist. The client learns about objects from state messages and clones templates to render them.

## What Changes

### Replaced / heavily rewritten
- `server/level.js` — `registerMeshRoots()` removed. Replaced by template registry + config-driven spawning. Split into: load arena GLB + spawn objects from config. The spawning loop reads `player` from each config entry and stores it on the gameObject. For trebuchets, registers `loadTargets` entries pointing to template nodes. `clearScene()` updated to only dispose arena root nodes (named `__root__`), preserving template root nodes (named `__template_*__`).

### New files
- `server/templateRegistry.js` — loads template GLBs at startup, keeps them in scene, extracts and caches physics data and node references. Renames template root nodes to `__template_{path}__`.
- `public/client/templateRegistry.js` — loads template GLBs at startup, hides root nodes, caches for cloning

### Updated
- `server/levelCatalog.js` — discovers `.json` configs alongside `.glb` arena files in `levels/`
- `server/utils.js` — type detection functions updated to use ID prefix instead of name substrings. `isLeftSideTrebuchetName()` and `sideSignForTrebuchet()` removed. `constrainedPointForObject()` updated to read `object.player` for trebuchet drag bounds. `toWireObject()` updated to include `player` field.
- `server/trebuchet.js` — `beginTrebuchetRelease()` updated: fire direction reads `trebuchet.player` instead of calling `sideSignForTrebuchet(trebuchet.id)`. `loadTargetForTrebuchet()` unchanged — it already repositions shared nodes before computing; the only difference is that `loadTargets` entries now point to template nodes instead of monolithic GLB nodes.
- `server/gameManager.js` — `playerIdForKing()` updated: reads `king.player` instead of checking `king.originX < 0`
- `server/input.js` — `dragStart` and `aimStart` handlers updated: added ownership guards using `object.player` / `trebuchet.player` to prevent players from dragging or aiming the opponent's trebuchet (pre-existing bugs, now fixed)
- `server/index.js` — startup calls template registry init before level load
- `public/client/utils.js` — `isLeftSideTrebuchetName()` removed. `isTrebuchetName()` and `isMissileName()` updated to use ID prefix checks (same as server). `isForwardPullPoint()` updated to accept a trebuchet state object and read `.player` instead of parsing the name. `isDraggableRoot()` unchanged (existing substring checks match new template-based IDs)
- `public/client/aim.js` — `updateAimArrow()` updated: passes trebuchet state object to `isForwardPullPoint()` instead of the trebuchet ID string
- `public/client/index.js` — startup calls template registry init before level load

### Unchanged
- `server/state.js` — exports `gameObjects`, `loadTargets`, `dragState`, `physicsAggregates`, and other maps. No structural changes — these maps are populated/cleared by other modules.
- `server/physics.js` — `createPhysicsBodies()` works from gameObject data, no change needed
- `server/simulation.js` — reads/writes gameObject properties, unaffected. Calls `loadTargetForTrebuchet()` which is unchanged.
- `server/network.js` — calls `toWireObject()`, unaffected (the function itself changes, not the caller)
- `public/client/state.js` — `applyState()` matches by ID, unaffected
- `public/client/input.js` — sends input messages, unaffected (ownership enforced server-side)

## Future Extensions

- **Per-instance overrides:** add `scale`, `rotation`, `color`, `collider: "convex"` fields to level config entries
- **Block fragmentation:** fragment meshes bundled in block GLBs, swap logic added to simulation
- **New object types:** add a new folder under `templates/`, update type detection, done
- **Object pooling:** if round transitions feel slow, pre-create clones and recycle instead of clone/destroy
