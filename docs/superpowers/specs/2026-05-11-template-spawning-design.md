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
    { "template": "trebuchets/basic", "x": -25, "y": 1, "z": 0 },
    { "template": "trebuchets/basic", "x": 25, "y": 1, "z": 0 },
    { "template": "kings/default", "x": -37, "y": 1.05, "z": 0 },
    { "template": "kings/default", "x": 37, "y": 1.05, "z": 0 },
    { "template": "blocks/wood", "x": -12, "y": 1, "z": 0 },
    { "template": "blocks/wood", "x": -12, "y": 9, "z": 0 },
    { "template": "blocks/wood", "x": 12, "y": 1, "z": 0 },
    { "template": "blocks/wood", "x": 12, "y": 9, "z": 0 },
    { "template": "missiles/basic", "x": 0, "y": 0.5, "z": 0 },
    { "template": "missiles/basic", "x": 0, "y": 6, "z": 0 }
  ]
}
```

Additional per-instance properties (scale, color) can be added later without changing the architecture.

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

Examples: `"blocks/wood_0"`, `"blocks/wood_1"`, `"missiles/basic_0"`, `"trebuchets/basic_0"`.

The template path prefix determines the object type, replacing all name-parsing heuristics (`isDynamicName`, `isMissileName`, etc.):
- `trebuchets/` prefix → trebuchet type
- `missiles/` prefix → missile type
- `blocks/` prefix → block type
- `kings/` prefix → king type

## Architecture

### Template Registry

A module on both server and client that loads all template GLBs once at startup.

**Server (`server/templateRegistry.js`):**
- Scans `public/assets/templates/` recursively for `.glb` files
- Loads each into the Babylon scene temporarily
- Extracts and caches per template:
  - Collider bounds (halfX/Y/Z, offsetX/Y/Z) from Col/ColVis children
  - Physics shape type (sphere for missiles, box for everything else)
  - Damping values (higher for trebuchets)
  - Trebuchet hierarchy info: arm node presence, load target offsets
- Disposes the loaded meshes after extraction — only data is kept
- Stores in a `Map<templatePath, TemplateData>`

**Client (`public/client/templateRegistry.js`):**
- Loads each template GLB into the scene
- Hides the root node (template is not rendered directly)
- Caches the root node for cloning
- Stores in a `Map<templatePath, TemplateNode>`

### Spawning Flow

#### Level Load (server)

1. Read level JSON config
2. Load arena GLB into scene (static environment)
3. For each object in config:
   a. Look up cached template data by `template` field
   b. Generate unique ID: `"{template}_{counter}"`
   c. Create gameObject entry with position from config + physics properties from template
   d. Create Havok physics body via existing `createPhysicsBodies()` logic
4. Start simulation, broadcast state to clients

#### Level Load (client)

1. Receive arena GLB URL from server (in welcome, roundStarted, or matchReset message)
2. Load arena GLB (environment visuals, camera, lights)
3. On first state message containing objects:
   a. For each object ID not yet in `visualObjects`:
      - Extract template path from ID (everything before last `_N`)
      - Clone the cached template node
      - Position at coordinates from state message
      - Register in `visualObjects`, `visualBaseRotations`
      - For trebuchets: register arm nodes and load targets from the clone
   b. Set up shadows
4. Subsequent state messages update positions/rotations as usual via `applyState()`

#### Level Transition

Same as current system:
- Server: `clearScene()` → load new arena + spawn from new config
- Client: `engine.stopRenderLoop()` → `clearLevel()` → load new arena → render loop resumes
- Templates are NOT reloaded — they persist across levels

### Type Detection

Current name-based functions are replaced with ID prefix checks:

| Current | New |
|---|---|
| `isDynamicName(name)` | All template-spawned objects are dynamic |
| `isTrebuchetName(name)` | `id.startsWith("trebuchets/")` |
| `isMissileName(name)` | `id.startsWith("missiles/")` |
| `isKingName(name)` | `id.startsWith("kings/")` |
| `isBlockName(name)` | `id.startsWith("blocks/")` |

These are updated in `server/utils.js`. The functions keep the same names and signatures for minimal downstream changes.

## Network Protocol

No new message types. Changes to existing messages:

- **welcome:** `level` field changes from `"/assets/level1.glb"` to `"/assets/levels/level1.glb"`
- **state:** unchanged — objects sent as `{ id, x, y, z, rot, ... }` with new ID format
- **roundStarted:** `level` field updated to new path
- **matchReset:** `level` field updated to new path

The client does not fetch level JSON configs. The server is the sole authority on what objects exist. The client learns about objects from state messages and clones templates to render them.

## What Changes

### Replaced / heavily rewritten
- `server/level.js` — `registerMeshRoots()` removed. Replaced by template registry + config-driven spawning. Split into: load arena GLB + spawn objects from config.
- `public/client/level.js` — `registerVisualRoots()` removed. Replaced by lazy cloning from templates on first state message.

### New files
- `server/templateRegistry.js` — loads template GLBs, extracts physics data
- `public/client/templateRegistry.js` — loads template GLBs, caches clonable nodes

### Updated
- `server/levelCatalog.js` — discovers `.json` configs alongside `.glb` arena files in `levels/`
- `server/utils.js` — type detection functions updated to use ID prefix instead of name substrings
- `server/index.js` — startup calls template registry init before level load
- `public/client/index.js` — startup calls template registry init before level load

### Unchanged
- `server/physics.js` — `createPhysicsBodies()` works from gameObject data, no change needed
- `server/simulation.js` — reads/writes gameObject properties, unaffected
- `server/trebuchet.js` — works with gameObject properties and loadTargets, unaffected
- `server/gameManager.js` — calls reloadLevel, unaffected
- `server/input.js` — unaffected
- `public/client/state.js` — `applyState()` matches by ID, unaffected
- `public/client/input.js` — unaffected
- `public/client/aim.js` — unaffected

## Future Extensions

- **Per-instance overrides:** add `scale`, `color`, `collider: "convex"` fields to level config entries
- **Block fragmentation:** fragment meshes bundled in block GLBs, swap logic added to simulation
- **New object types:** add a new folder under `templates/`, update type detection, done
- **Object pooling:** if round transitions feel slow, pre-create clones and recycle instead of clone/destroy
