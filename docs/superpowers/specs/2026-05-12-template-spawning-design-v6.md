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
    { "template": "blocks/wood", "x": -12, "y": 9, "z": 0, "rotation": 45 },
    { "template": "blocks/wood", "x": 12, "y": 1, "z": 0 },
    { "template": "blocks/wood", "x": 12, "y": 9, "z": 0, "rotation": -45 },
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
| `rotation` | no | number | Initial Z-axis rotation in degrees. Defaults to `0`. Matches the existing protocol convention (positive = counter-clockwise). Stored as `originRot` on the gameObject for round reset |
| `player` | trebuchets, kings | `1` or `2` | Owning player. Required for trebuchets and kings. Omit for shared objects (blocks, missiles) |

Additional per-instance properties (scale, color) can be added later without changing the architecture.

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

**`server/game/entities.js` — replace name-based side detection:**

`isLeftSideTrebuchetName(name)` and `sideSignForTrebuchet(name)` are removed entirely. They are replaced by direct reads from the gameObject's `player` field:

| Current code | Location | Replacement |
|---|---|---|
| `sideSignForTrebuchet(trebuchet.id)` | `server/game/trebuchet.js:177` — fire direction | `trebuchet.player === 1 ? 1 : -1` |
| `isLeftSideTrebuchetName(object.id)` for `minX`/`maxX` | `server/game/entities.js:113-118` — drag bounds in `constrainedPointForObject()` | `object.player === 1` checks against `trebuchetLeftMinX`/`trebuchetLeftMaxX`, otherwise `trebuchetRightMinX`/`trebuchetRightMaxX` |

**`server/game/trebuchet.js` — fire direction:**

```js
// Before (broken with template IDs):
const shotDirectionX = sideSignForTrebuchet(trebuchet.id);

// After:
const shotDirectionX = trebuchet.player === 1 ? 1 : -1;
```

**`server/game/drag.js` — add trebuchet ownership check:**

The current code has no ownership validation on `dragStart` for trebuchets — any connected player can drag any trebuchet. This is a pre-existing bug that becomes critical with template IDs (no name to even accidentally filter on).

`handleDragStart` — add a guard after the current non-trebuchet check (`drag.js:49`), before setting `draggedBy`:

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

**`server/game/input.js` — add trebuchet aim ownership check:**

`aimStart` handler — add a guard after finding the trebuchet via `missile.loadedInto` (`input.js:39-40`), before setting `fireState`:

```js
if (trebuchet.player && trebuchet.player !== client.id) return;
```

Both checks ensure player 1 cannot drag or aim player 2's trebuchet and vice versa. The checks are skipped if `player` is null (defensive, should not happen for trebuchets).

**`server/game/rules.js` — king knockout attribution:**

```js
// Before (position-based, rules.js:65-67):
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
// Before (aim.js:142):
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
// In the spawning loop (server/game/level.js):
const entry = config.objects[i];
const gameObject = {
  id: generatedId,
  x: entry.x,
  y: entry.y,
  z: entry.z,
  originX: entry.x,
  originY: entry.y,
  originZ: entry.z,
  rot: entry.rotation ?? 0,
  originRot: entry.rotation ?? 0,
  // ... physics properties from template ...
  player: entry.player ?? null,  // null for blocks, missiles
};
```

`player` is a plain integer (1 or 2) or null — set once at spawn, never changes. `originRot` stores the initial rotation from the config for round reset (same pattern as `originX/Y/Z`).

**`server/game/rules.js` — `resetGameState()` uses `originRot`:**

The current code hardcodes `object.rot = 0` on reset (`rules.js:22`). With per-instance rotation, it resets to the config value:

```js
// Before:
object.rot = 0;

// After:
object.rot = object.originRot ?? 0;
```

The physics body sync on the next line already reads `object.rot` via `rotationQuaternionForObject()`, so the physics body respects the initial rotation automatically.

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

A module on both server and client that loads all template GLBs once and keeps them in memory permanently.

**Server (`server/game/templateRegistry.js`):**
- Scans `public/assets/templates/` recursively for `.glb` files
- Builds the template path list (e.g., `["blocks/wood", "missiles/basic", "trebuchets/basic", "kings/default"]`) and exposes it for the `welcome` message (see Network Protocol below)
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
- Receives the template path list from the `welcome` message (the browser cannot scan directories)
- Loads template GLBs **sequentially** (same pattern as server). Each `AppendAsync` creates a `__root__` node; renaming it before the next load prevents ambiguity. Sequential loading avoids a race condition where parallel loads produce multiple `__root__` nodes simultaneously, making it impossible to reliably associate each root with its template:

```js
export async function initTemplateRegistry(templatePaths) {
  for (const templatePath of templatePaths) {
    const before = new Set(scene.rootNodes);
    await SceneLoader.AppendAsync("/assets/templates/", `${templatePath}.glb`, scene);
    const newRoot = scene.rootNodes.find((n) => !before.has(n));
    newRoot.name = `__template_${templatePath}__`;
    newRoot.setEnabled(false);
    templateCache.set(templatePath, newRoot);
  }
}
```

- Hides each template root node (`setEnabled(false)`) — not rendered directly
- Caches the root node for cloning
- Stores in a `Map<templatePath, rootNode>`
- Templates are never disposed — they persist across level transitions

### Client Startup Flow

The current client startup in `public/client/index.js` loads the level immediately:

```js
// Current:
loadLevel().then(() => {
  engine.runRenderLoop(() => { scene.render(); });
});
```

This must change because the client needs the template list from the `welcome` message before it can load anything. The new startup flow:

1. `index.js` sets up input and connects the WebSocket (via `network.js` import)
2. `network.js` receives the `welcome` message containing `templates` and `level`
3. `network.js` calls `initTemplateRegistry(message.templates)` — loads all template GLBs
4. After templates are loaded, calls `loadLevel(message.level)` — loads the arena GLB
5. After the arena is loaded, starts the render loop: `engine.runRenderLoop(...)`
6. State messages that arrive during steps 3-5 are **dropped** via a `ready` gate. An `async` event handler suspends at each `await`, returning control to the browser — so subsequent `message` events fire their own independent handler invocations while the welcome handler is suspended. Without a guard, these invocations would try to clone from an empty `templateCache` and either throw or silently produce no visuals. The `ready` flag prevents this: it is set to `true` only after the welcome handler's full `await` chain completes. Dropping state messages during loading is safe because each state message is a full snapshot (not a delta) — the first message after `ready = true` contains every object at its current position.

```js
// public/client/index.js — new:
import { engine, scene } from "./engine.js";
import { setupInput } from "./input.js";
import "./network.js";
import "./aim.js";

setupInput();

// Render loop is started by network.js after welcome → templates → level load completes.
// No immediate loadLevel() call here.

window.addEventListener("resize", () => { engine.resize(); });
```

The `message` event handler must be changed to `async` with a `ready` gate (currently it is a plain synchronous function at `network.js:94`):

```js
// public/client/network.js — message handler becomes async with ready gate:
let ready = false;

socket.addEventListener("message", async (event) => {
  const message = JSON.parse(event.data);

  if (message.type === "welcome") {
    playerEl.textContent = message.playerId;
    const { initTemplateRegistry } = await import("./templateRegistry.js");
    await initTemplateRegistry(message.templates);
    await loadLevel(message.level);
    engine.runRenderLoop(() => { scene.render(); });
    ready = true;
    return;
  }

  if (!ready) return;

  // ... other handlers (state, roundEnded, etc.) only run after init completes ...
});
```

For level transitions (`roundStarted`, `matchReset`), templates are already loaded. Only the arena reloads:

```js
// These handlers remain the same — reloadLevel() only reloads the arena GLB:
if (message.type === "roundStarted") {
  if (message.level) reloadLevel(message.level);
}
if (message.type === "matchReset") {
  // ... reset UI ...
  if (message.level) reloadLevel(message.level);
}
```

### Client Level Load (with templates)

After templates are loaded and cached, the client's `loadLevel()` changes from loading a monolithic GLB to loading just the arena GLB. Object visuals are created by cloning templates on the first state message:

1. `loadLevel(arenaUrl)` loads the arena GLB (environment, camera, lights)
2. `ensureCameraAndLight()` and `setupShadows()` run as before
3. On first state message containing objects, for each object ID not yet in `visualObjects`:
   - Extract template path from ID (everything before last `_`)
   - Clone the cached template node: `templateCache.get(templatePath).clone(objectId)`
   - Set the clone's name to the object ID (for `findGameplayRoot` / `isDraggableRoot`)
   - Enable the clone (`setEnabled(true)`)
   - Position at coordinates from state message
   - Register in `visualObjects`, `visualBaseRotations`
   - For trebuchets: find arm node and load target in the clone's hierarchy, register in `trebuchetArmNodes` and `trebuchetLoadTargets`
   - For missiles: create pick collider via existing `createMissilePickCollider()`
   - Register clone's visual meshes with the shadow generator's render list
4. After clones are created, `applyState()` runs on the same state message — this applies the server's `rot` value (which carries the config rotation) to each clone via `protocolToBabylonRotation`. Clones from templates have a base rotation of 0 on all axes, so the server's `rot` field alone determines the visual rotation. Objects spawned at 45 degrees in the config appear at 45 degrees on the client immediately.
5. Subsequent state messages update positions/rotations as usual via `applyState()`

### Client Level Transition

`clearLevel()` is updated to dispose clones explicitly and preserve template nodes. Clone disposal must happen **before** clearing `visualObjects` (otherwise the references are lost). Template root nodes are named `__template_*__` and excluded by the `__root__` filter:

```js
function clearLevel() {
  // Dispose cloned gameplay objects first (while visualObjects still has references)
  for (const visual of visualObjects.values()) {
    visual.dispose(false, true);
  }
  visualObjects.clear();
  visualBaseRotations.clear();
  trebuchetArmNodes.clear();
  trebuchetLoadTargets.clear();
  latestObjectStates.clear();

  for (const generator of scene.shadowGenerators?.slice() ?? []) {
    generator.dispose();
  }

  // Then dispose arena root nodes (environment, camera, lights)
  const arenaRoots = scene.rootNodes.filter((n) => n.name === "__root__");
  for (const root of arenaRoots) {
    root.dispose(false, true);
  }
}
```

This removes all cloned gameplay objects while preserving the hidden template nodes.

**Shadow generator access for clones:** The current `setupShadows()` creates a `ShadowGenerator` as a local variable. Since clones are created after `setupShadows()` runs, the clone creation code needs access to the generator to register clone meshes as shadow casters. Store the shadow generator in a module-level variable in `level.js` (e.g., `let activeShadowGenerator = null`) and set it in `setupShadows()`. The clone creation code calls `activeShadowGenerator.addShadowCaster(mesh, true)` for each Vis/ColVis mesh in the clone.

### Load Target Computation

The server computes the missile load target position every tick for loaded missiles. This position depends on the trebuchet's current world position and arm angle — the load target traces an arc as the arm rotates during aiming and firing.

**Current system (`server/game/trebuchet.js:73-106`):**

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

Note: the current code has a `loadTargets.get("default")` fallback (populated by `registerMeshRoots` at `server/game/registration.js:152`). With template-based spawning, every trebuchet instance gets an explicit `loadTargets` entry keyed by its generated ID, so the `"default"` key is no longer populated. The fallback chain in `loadTargetForTrebuchet` (`loadTargets.get(trebuchet.id) ?? loadTargets.get("default")`) still works — the primary lookup succeeds, making the `"default"` branch dead code. It can be removed for clarity during implementation.

### Spawning Flow

#### Level Load (server)

1. Read level JSON config
2. Load arena GLB into scene (static environment)
3. For each object in config:
   a. Look up cached template data by `template` field
   b. Generate unique ID: `"{template}_{counter}"` (counter is per-template)
   c. Create gameObject entry with position from config + rotation from config (default 0) + physics properties from template + `player` from config (null if absent). Store position as `originX/Y/Z` and rotation as `originRot` for round reset. **`originX/Y/Z` must always be set** — `simulation.js` snaps every object to `object.originZ` each tick to enforce the 2D plane constraint, and `physics.js` does the same for the Havok body. If any `origin` field is missing, objects drift off-plane or reset to wrong positions silently
   d. For trebuchets: register `loadTargets` entry pointing to the template's arm/target nodes
   e. Create Havok physics body via existing `createPhysicsBodies()` logic
4. Start simulation, broadcast state to clients

#### Level Transition (server)

`clearScene()` in `server/game/level.js` is updated to preserve template nodes:

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

The current `clearScene()` (`level.js:35-47`) disposes all nodes named `__root__` and clears `physicsAggregates`, `gameObjects`, and `loadTargets`. Two changes:

1. Template nodes are renamed to `__template_{path}__` during registry init, so the `__root__` filter excludes them.
2. `dragState.clear()` is added — the current code does not clear drag state during level transitions (only during within-level resets in `resetGameState()` at `rules.js:16`). This is a bug fix: without it, stale drag references from the previous level could persist.

`loadTargets` is cleared because the old trebuchet instance IDs no longer exist — it will be re-populated with new instance IDs when the next level spawns trebuchets.

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

These are updated in `server/game/entities.js` and `public/client/utils.js`. The type-check functions (`isTrebuchetName`, etc.) keep the same names and signatures for minimal downstream changes. The side-detection functions (`isLeftSideTrebuchetName`, `sideSignForTrebuchet`) are removed — their callers are updated to read `object.player` directly.

## Network Protocol

No new message types. Changes to existing messages:

### Welcome message — templates field

The `welcome` message adds a `templates` array containing all available template paths. The server builds this list from the template registry at startup:

```js
// server/net/connections.js — updated welcome message:
socket.send(JSON.stringify({
  type: "welcome",
  clientId,
  playerId,
  tickRate: TICK_RATE,
  level: gameState.currentLevel?.url ?? "/assets/levels/level1.glb",
  templates: templateRegistry.getAllPaths(),
  // e.g., ["blocks/wood", "missiles/basic", "trebuchets/basic", "kings/default"]
}));
```

The client uses this list to load all template GLBs before rendering (see Client Startup Flow above). The list contains every template on the server, not just those used by the current level — templates persist across levels and any future level could reference any template.

### Other message changes

- **welcome:** `level` field changes from `"/assets/level1.glb"` to `"/assets/levels/level1.glb"`. `templates` field added (see above).
- **state:** the `player` field is included on trebuchet and king objects (see below)
- **roundStarted:** `level` field updated to new path
- **matchReset:** `level` field updated to new path

### State message — player field

`toWireObject()` in `server/game/entities.js` is updated to include `player` when present:

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
- `server/game/level.js` — `loadLevelIfPresent()` rewritten to load arena GLB + spawn objects from JSON config instead of scanning mesh names. The spawning loop reads `player` and `rotation` from each config entry, stores `player` on the gameObject and `rotation` as both `rot` and `originRot`. For trebuchets, registers `loadTargets` entries pointing to template nodes. `clearScene()` updated to only dispose arena root nodes (named `__root__`), preserving template root nodes (named `__template_*__`), and to clear `dragState`.
- `server/game/registration.js` — `registerMeshRoots()` **removed entirely**. This module scans the Babylon scene for gameplay meshes by name — replaced by config-driven spawning in `level.js`. The collider bounds extraction logic (`colliderBoundsFor`, `boundsForNodes`, `childRole`) moves into `server/game/templateRegistry.js` where it runs once per template at startup instead of per-level-load.
- `public/client/level.js` — `registerVisualRoots()`, `registerTrebuchetArmNodes()`, `registerTrebuchetLoadTargets()` removed. Replaced by lazy cloning from templates on first state message. `clearLevel()` updated to dispose cloned instances and arena nodes while preserving template nodes. `loadLevel()` simplified to only load the arena GLB — object visuals are created by cloning templates when state messages arrive. `setupShadows()` stores the shadow generator in a module-level variable for clone registration.

### New files
- `server/game/templateRegistry.js` — loads template GLBs at startup, keeps them in scene, extracts and caches physics data and node references. Renames template root nodes to `__template_{path}__`. Exposes `getAllPaths()` for the welcome message. Reuses collider bounds logic from the now-removed `registration.js`.
- `public/client/templateRegistry.js` — receives template list from welcome message, loads template GLBs sequentially, caches root nodes for cloning. Renames template root nodes to `__template_{path}__`.

### Updated
- `server/game/levelCatalog.js` — discovers `.json` configs alongside `.glb` arena files in `levels/`
- `server/game/entities.js` — type detection functions (`isTrebuchetName`, `isMissileName`, `isKingName`, `isDynamicName`) updated to use ID prefix instead of name substrings. `isLeftSideTrebuchetName()` and `sideSignForTrebuchet()` removed. `constrainedPointForObject()` updated to read `object.player` for trebuchet drag bounds. `toWireObject()` updated to include `player` field.
- `server/game/trebuchet.js` — `beginTrebuchetRelease()` updated: fire direction reads `trebuchet.player` instead of calling `sideSignForTrebuchet(trebuchet.id)`. `loadTargetForTrebuchet()` unchanged — it already repositions shared nodes before computing; the only difference is that `loadTargets` entries now point to template nodes instead of monolithic GLB nodes.
- `server/game/rules.js` — `playerIdForKing()` updated: reads `king.player` instead of checking `king.originX < 0`. `resetGameState()` updated: resets `object.rot` to `object.originRot ?? 0` instead of hardcoded `0`.
- `server/game/drag.js` — `handleDragStart` updated: added ownership guard using `object.player` to prevent players from dragging the opponent's trebuchet (pre-existing bug, now fixed).
- `server/game/input.js` — `aimStart` handler updated: added ownership guard using `trebuchet.player` to prevent players from aiming the opponent's trebuchet (pre-existing bug, now fixed).
- `server/index.js` — startup calls template registry init before level load. Welcome message format updated in `server/net/connections.js`.
- `server/net/connections.js` — welcome message updated to include `templates` array from `templateRegistry.getAllPaths()`.
- `public/client/index.js` — no longer calls `loadLevel()` directly at startup. The render loop is started by `network.js` after the welcome → template load → arena load sequence completes. Only input setup and resize handler remain.
- `public/client/network.js` — `welcome` handler updated: triggers template loading via `initTemplateRegistry(message.templates)`, then loads the arena via `loadLevel(message.level)`, then starts the render loop and sets `ready = true`. A `ready` gate drops all non-welcome messages until init completes — this prevents state messages from hitting an empty `templateCache` during the async init chain.
- `public/client/utils.js` — `isLeftSideTrebuchetName()` removed. `isTrebuchetName()` and `isMissileName()` updated to use ID prefix checks (same as server). `isForwardPullPoint()` updated to accept a trebuchet state object and read `.player` instead of parsing the name. `isDraggableRoot()` unchanged (existing substring checks match new template-based IDs).
- `public/client/aim.js` — `updateAimArrow()` updated: passes trebuchet state object to `isForwardPullPoint()` instead of the trebuchet ID string.

### Unchanged
- `server/game/state.js` — exports `gameObjects`, `loadTargets`, `dragState`, and other maps. No structural changes — these maps are populated/cleared by other modules.
- `server/game/physics.js` — `createPhysicsBodies()` works from gameObject data, no change needed. Note: `constrainBodyToPlane()` reads `object.originZ` and `object.originY` to lock physics bodies — these must be set during spawning (see Spawning Flow step 3c).
- `server/game/simulation.js` — reads/writes gameObject properties, unaffected. Calls `loadTargetForTrebuchet()` which is unchanged. Note: snaps `object.z` to `object.originZ` every tick (`simulation.js:70`) — this is the 2D plane constraint and depends on `originZ` being set during spawning.
- `server/game/loop.js` — game loop tick, unaffected.
- `server/net/broadcast.js` — calls `toWireObject()`, unaffected (the function itself changes, not the caller).
- `server/config.js` — configuration constants, unaffected.
- `server/math.js` — math utilities, unaffected.
- `public/client/state.js` — `applyState()` matches by ID, unaffected. State messages arriving before templates/arena are loaded are dropped by the `ready` gate in `network.js`.
- `public/client/input.js` — sends input messages, unaffected (ownership enforced server-side).

## Future Extensions

- **Per-instance overrides:** add `scale`, `color`, `collider: "convex"` fields to level config entries
- **Block fragmentation:** fragment meshes bundled in block GLBs, swap logic added to simulation
- **New object types:** add a new folder under `templates/`, update type detection, done
- **Object pooling:** if round transitions feel slow, pre-create clones and recycle instead of clone/destroy
