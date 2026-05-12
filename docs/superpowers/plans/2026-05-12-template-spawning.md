# Template-Based Object Spawning — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace monolithic GLB parsing with separate template GLBs per object variant and JSON level configs that define what to spawn and where.

**Architecture:** Server template registry loads template GLBs once at startup, extracts physics data and node references. Level loading reads a JSON config and spawns gameObjects from cached template data. Client receives template paths via welcome message, loads template GLBs, and lazily clones them on first state message. Player ownership replaces name-based side detection.

**Tech Stack:** Babylon.js (NullEngine server, WebGL client), Havok physics, WebSocket, Express static serving

**Prerequisite — Blender exports:** Before runtime testing, export from Blender: (1) arena-only GLB (ground, barriers, lights, camera) → `public/assets/levels/level1.glb`, (2) one GLB per object type → `public/assets/templates/{type}/{variant}.glb`. The code can be written and committed without these assets; manual testing requires them.

**Blender export constraint:** Each template GLB must have the gameplay root as a direct child of the scene root. Specifically, the trebuchet arm node's parent must contain "trebuche" in its name (e.g., "Trebuchet", "TrebuchetBody"). Do NOT wrap templates in extra container nodes like "Scene" or "Collection" — the client's `isTrebuchetArmRoot` checks `transform.parent.name` for this substring. If intermediate nodes exist, arm detection silently fails and the aim animation breaks.

**Arena physics note:** The new system only creates Havok physics bodies for config-spawned objects. Static arena geometry (ground, barriers) does NOT get physics bodies. The server already enforces floor collision (Y-clamping in `simulation.js:76-82`) and world bounds (`constrainWorldBounds` in `entities.js:85-98`). If the current monolithic GLB contains barrier meshes that blocks physically bounce off via Havok, those interactions will be lost. Verify the current game does not rely on arena-to-object Havok collisions before switching.

---

## File Structure

**New files:**
- `public/assets/levels/level1.json` — level 1 spawn config
- `server/game/templateRegistry.js` — server: loads template GLBs, extracts physics data, caches node refs
- `public/client/templateRegistry.js` — client: loads template GLBs from welcome message, caches for cloning

**Modified files:**
- `server/game/levelCatalog.js` — scan `levels/` subdir for paired GLB+JSON
- `server/game/level.js` — config-driven spawning, clearScene preserves templates
- `server/index.js` — init template registry before level load
- `server/net/connections.js` — add `templates` to welcome message
- `server/game/entities.js` — prefix-based type detection, remove side detection, add `player` to wire
- `server/game/drag.js` — trebuchet ownership guard
- `server/game/input.js` — aim ownership guard
- `server/game/trebuchet.js` — fire direction from `.player`
- `server/game/rules.js` — king attribution from `.player`, `originRot` reset
- `public/client/level.js` — arena-only load, lazy clone creation, shadow generator exposure
- `public/client/index.js` — remove direct `loadLevel()` call
- `public/client/network.js` — async message handler with ready gate
- `public/client/utils.js` — remove `isLeftSideTrebuchetName`, update `isForwardPullPoint`
- `public/client/aim.js` — pass trebuchet state to `isForwardPullPoint`

**Deleted files:**
- `server/game/registration.js` — replaced by template registry + config spawning

---

### Task 1: Asset directory structure & level config

**Files:**
- Create: `public/assets/levels/level1.json`
- Create: `public/assets/templates/blocks/.gitkeep`
- Create: `public/assets/templates/missiles/.gitkeep`
- Create: `public/assets/templates/trebuchets/.gitkeep`
- Create: `public/assets/templates/kings/.gitkeep`

- [ ] **Step 1: Create asset directories**

```bash
mkdir -p public/assets/levels
mkdir -p public/assets/templates/blocks
mkdir -p public/assets/templates/missiles
mkdir -p public/assets/templates/trebuchets
mkdir -p public/assets/templates/kings
```

- [ ] **Step 2: Create .gitkeep files for empty template directories**

```bash
touch public/assets/templates/blocks/.gitkeep
touch public/assets/templates/missiles/.gitkeep
touch public/assets/templates/trebuchets/.gitkeep
touch public/assets/templates/kings/.gitkeep
```

- [ ] **Step 3: Create level1.json config**

Create `public/assets/levels/level1.json`:

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

Note: These positions are approximate. To get exact positions from the current monolithic GLB, run the server with the old level and read the logged coordinates. Adjust this file to match.

- [ ] **Step 4: Commit**

```bash
git add public/assets/levels/ public/assets/templates/
git commit -m "feat: add asset directory structure and level1 spawn config"
```

---

### Task 2: Level catalog — discover levels from `levels/` subdir

**Files:**
- Modify: `server/game/levelCatalog.js`

- [ ] **Step 1: Rewrite discoverLevels to scan levels/ subdir for JSON configs**

Replace the entire contents of `server/game/levelCatalog.js`:

```js
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.join(__dirname, "../../public/assets");
const levelsDir = path.join(assetsDir, "levels");

let levels = [];

export async function discoverLevels() {
  let files;
  try {
    files = await fs.readdir(levelsDir);
  } catch {
    console.log("No levels/ directory found; using empty level list.");
    levels = [];
    return levels;
  }

  levels = files
    .filter((f) => f.endsWith(".json"))
    .sort((a, b) => {
      const numA = parseInt(a.match(/\d+/)?.[0] ?? "0", 10);
      const numB = parseInt(b.match(/\d+/)?.[0] ?? "0", 10);
      return numA - numB;
    })
    .map((jsonFile) => {
      const id = jsonFile.replace(".json", "");
      return {
        id,
        file: `levels/${id}.glb`,
        url: `/assets/levels/${id}.glb`,
        config: `levels/${jsonFile}`,
      };
    });

  if (levels.length === 0) {
    console.log("No level JSON configs found in levels/.");
  } else {
    console.log(`Discovered ${levels.length} level(s): ${levels.map((l) => l.id).join(", ")}`);
  }

  return levels;
}

export function firstLevel() {
  return levels[0] ?? null;
}

export function nextLevel(currentLevelId) {
  const index = levels.findIndex((l) => l.id === currentLevelId);
  if (index < 0) return firstLevel();
  return levels[(index + 1) % levels.length];
}
```

- [ ] **Step 2: Verify the change compiles**

Run: `node --check server/game/levelCatalog.js`
Expected: No output (no syntax errors)

- [ ] **Step 3: Commit**

```bash
git add server/game/levelCatalog.js
git commit -m "feat: update level catalog to discover JSON configs from levels/ subdir"
```

---

### Task 3: Server template registry

**Files:**
- Create: `server/game/templateRegistry.js`

- [ ] **Step 1: Create the template registry module**

Create `server/game/templateRegistry.js`:

```js
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import xhr2 from "xhr2";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader.js";
import "@babylonjs/loaders/glTF/index.js";
import { scene } from "./physics.js";
import { PORT } from "../config.js";
import { BARRAGE_CONFIG } from "../../public/config.js";

const { XMLHttpRequest } = xhr2;
globalThis.XMLHttpRequest = XMLHttpRequest;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templatesDir = path.join(__dirname, "../../public/assets/templates");

const templateCache = new Map();
let allPaths = [];

function childRole(name) {
  if (name.includes("ColVis")) return "ColVis";
  if (name.includes("Visual") || name.includes("Vis")) return "Vis";
  if (name.includes("Collider") || name.includes("Col")) return "Col";
  return null;
}

function descendantsOf(transform) {
  const result = [];
  const stack = [...transform.getChildren()];
  while (stack.length > 0) {
    const child = stack.pop();
    result.push(child);
    if (typeof child.getChildren === "function") {
      stack.push(...child.getChildren());
    }
  }
  return result;
}

function isTrebuchetArmNode(transform) {
  const lower = transform.name.toLowerCase();
  if (!lower.includes("arm")) return false;
  if (lower.includes("visual") || lower.includes("collider") || lower.includes("col")) return false;
  if (!transform.parent) return false;
  return descendantsOf(transform).some((c) => c.name.toLowerCase().includes("missile-load-target"));
}

function isArmDescendant(root, node) {
  let current = node.parent;
  while (current && current !== root) {
    if (isTrebuchetArmNode(current)) return true;
    current = current.parent;
  }
  return false;
}

function boundsForNodes(nodes) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const node of nodes) {
    const bounds = typeof node.getHierarchyBoundingVectors === "function"
      ? node.getHierarchyBoundingVectors(true)
      : node.getBoundingInfo?.().boundingBox;
    if (!bounds) continue;
    const min = bounds.min ?? bounds.minimumWorld;
    const max = bounds.max ?? bounds.maximumWorld;
    minX = Math.min(minX, min.x);
    minY = Math.min(minY, min.y);
    minZ = Math.min(minZ, min.z);
    maxX = Math.max(maxX, max.x);
    maxY = Math.max(maxY, max.y);
    maxZ = Math.max(maxZ, max.z);
  }
  if (!Number.isFinite(minX)) throw new Error("No bounds");
  return { min: new Vector3(minX, minY, minZ), max: new Vector3(maxX, maxY, maxZ) };
}

function colliderBoundsFor(root) {
  try {
    const descendants = descendantsOf(root);
    const colliderNodes = descendants.filter((child) => {
      const role = childRole(child.name);
      return (role === "Col" || role === "ColVis") && !isArmDescendant(root, child);
    });
    const bounds = boundsForNodes(colliderNodes.length > 0 ? colliderNodes : [root]);
    const position = root.getAbsolutePosition();
    const centerX = (bounds.min.x + bounds.max.x) / 2;
    const centerY = (bounds.min.y + bounds.max.y) / 2;
    const centerZ = (bounds.min.z + bounds.max.z) / 2;
    return {
      offsetX: centerX - position.x,
      offsetY: centerY - position.y,
      offsetZ: centerZ - position.z,
      halfX: Math.max(0.05, (bounds.max.x - bounds.min.x) / 2),
      halfY: Math.max(0.05, (bounds.max.y - bounds.min.y) / 2),
      halfZ: Math.max(0.05, (bounds.max.z - bounds.min.z) / 2),
    };
  } catch {
    return { offsetX: 0, offsetY: 0, offsetZ: 0, halfX: 0.5, halfY: 0.5, halfZ: 0.5 };
  }
}

function extractTrebuchetNodes(root) {
  const descendants = descendantsOf(root);
  let armNode = null;
  let targetNode = null;

  for (const node of descendants) {
    if (!armNode && isTrebuchetArmNode(node)) armNode = node;
    if (!targetNode && node.name.toLowerCase().includes("missile-load-target")) targetNode = node;
  }

  if (!targetNode) return null;

  const restDegrees = BARRAGE_CONFIG.trebuchetArmRestRotationZDegrees ?? 15;
  if (armNode) {
    armNode.rotationQuaternion = null;
    armNode.rotation.z = (restDegrees * Math.PI) / 180;
  }
  root.computeWorldMatrix(true);
  armNode?.computeWorldMatrix(true);
  targetNode.computeWorldMatrix(true);

  const targetPos = targetNode.getAbsolutePosition();
  const rootPos = root.getAbsolutePosition();

  return {
    rootNode: root,
    armNode,
    targetNode,
    loadTargetOffsetX: -(targetPos.x - rootPos.x),
    loadTargetOffsetY: targetPos.y - rootPos.y,
    loadTargetOffsetZ: targetPos.z - rootPos.z,
  };
}

async function discoverPaths() {
  const result = [];
  async function walk(dir, prefix) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), childPrefix);
      } else if (entry.name.endsWith(".glb")) {
        result.push(childPrefix.replace(".glb", ""));
      }
    }
  }
  await walk(templatesDir, "");
  return result;
}

export async function initTemplateRegistry() {
  allPaths = await discoverPaths();
  if (allPaths.length === 0) {
    console.log("No template GLBs found in public/assets/templates/");
    return;
  }

  const baseUrl = `http://localhost:${PORT}/assets/templates/`;

  for (const templatePath of allPaths) {
    const before = new Set(scene.rootNodes);
    await SceneLoader.AppendAsync(baseUrl, `${templatePath}.glb`, scene);
    const newRoot = scene.rootNodes.find((n) => !before.has(n));
    newRoot.name = `__template_${templatePath}__`;

    const bounds = colliderBoundsFor(newRoot);
    const isTrebuchet = templatePath.startsWith("trebuchets/");
    const trebuchetNodes = isTrebuchet ? extractTrebuchetNodes(newRoot) : null;

    templateCache.set(templatePath, {
      bounds,
      ...(trebuchetNodes ?? {}),
    });

    console.log(`Template "${templatePath}": half=(${bounds.halfX.toFixed(2)}, ${bounds.halfY.toFixed(2)}, ${bounds.halfZ.toFixed(2)})`);
  }

  console.log(`Loaded ${templateCache.size} template(s).`);
}

export function getTemplate(templatePath) {
  return templateCache.get(templatePath);
}

export function getAllPaths() {
  return allPaths;
}
```

- [ ] **Step 2: Verify syntax**

Run: `node --check server/game/templateRegistry.js`
Expected: No output (no syntax errors)

- [ ] **Step 3: Commit**

```bash
git add server/game/templateRegistry.js
git commit -m "feat: add server template registry for loading and caching template GLBs"
```

---

### Task 4: Server level rewrite — config-driven spawning

**Files:**
- Modify: `server/game/level.js`

- [ ] **Step 1: Rewrite level.js with config-driven spawning**

Replace the entire contents of `server/game/level.js`:

```js
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import xhr2 from "xhr2";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader.js";
import "@babylonjs/loaders/glTF/index.js";
import { scene, physicsAggregates, createPhysicsBodies } from "./physics.js";
import { gameObjects, loadTargets, dragState, gameState } from "./state.js";
import { PORT } from "../config.js";
import { SERVER_CONFIG } from "../config.js";
import {
  isTrebuchetName,
  isMissileName,
  isKingName,
  restArmAngleForTrebuchet,
  ARM_STATE_IDLE,
} from "./entities.js";
import { getTemplate } from "./templateRegistry.js";

const { XMLHttpRequest } = xhr2;
globalThis.XMLHttpRequest = XMLHttpRequest;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.join(__dirname, "../../public/assets");

function clearScene() {
  for (const [, aggregate] of physicsAggregates) {
    aggregate.dispose();
  }
  physicsAggregates.clear();
  gameObjects.clear();
  loadTargets.clear();
  dragState.clear();

  const arenaRoots = scene.rootNodes.filter((n) => n.name === "__root__");
  for (const root of arenaRoots) {
    root.dispose(false, true);
  }
}

function spawnObjectsFromConfig(config) {
  const counters = new Map();

  for (const entry of config.objects) {
    const templatePath = entry.template;
    const count = counters.get(templatePath) ?? 0;
    counters.set(templatePath, count + 1);
    const generatedId = `${templatePath}_${count}`;

    const templateData = getTemplate(templatePath);
    if (!templateData) {
      console.warn(`Template "${templatePath}" not found in registry, skipping ${generatedId}`);
      continue;
    }

    const bounds = templateData.bounds;

    const object = {
      id: generatedId,
      x: entry.x,
      y: entry.y,
      z: entry.z,
      originX: entry.x,
      originY: entry.y,
      originZ: entry.z,
      rot: entry.rotation ?? 0,
      originRot: entry.rotation ?? 0,
      angularVelocity: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      dragVx: 0,
      dragVy: 0,
      dragVz: 0,
      dynamic: true,
      draggedBy: null,
      offsetX: bounds.offsetX,
      offsetY: bounds.offsetY,
      offsetZ: bounds.offsetZ,
      halfX: bounds.halfX,
      halfY: bounds.halfY,
      halfZ: bounds.halfZ,
      halfHeight: bounds.halfY,
      mass: SERVER_CONFIG.dynamicMass,
      friction: SERVER_CONFIG.dynamicFriction,
      restitution: SERVER_CONFIG.dynamicRestitution,
      player: entry.player ?? null,
      ...(isTrebuchetName(generatedId) ? {
        loaded: false,
        loadedMissileId: null,
        fireState: ARM_STATE_IDLE,
        armAngle: restArmAngleForTrebuchet(),
        aimedBy: null,
        aimStart: null,
        aimCurrent: null,
        pendingShot: null,
        returnStartArmAngle: null,
        releaseElapsedMs: 0,
      } : {}),
      ...(isMissileName(generatedId) ? { loadedInto: null } : {}),
      ...(isKingName(generatedId) ? { hits: 0, maxHits: 3 } : {}),
    };

    gameObjects.set(generatedId, object);

    if (isTrebuchetName(generatedId) && templateData.targetNode) {
      loadTargets.set(generatedId, {
        targetNode: templateData.targetNode,
        rootNode: templateData.rootNode,
        armNode: templateData.armNode,
        offsetX: templateData.loadTargetOffsetX,
        offsetY: templateData.loadTargetOffsetY,
        offsetZ: templateData.loadTargetOffsetZ,
      });
    }
  }

  createPhysicsBodies();
}

export async function loadLevelIfPresent(level) {
  if (!level) {
    console.log("No level to load.");
    return;
  }

  const arenaFile = level.file;
  const arenaPath = path.join(assetsDir, arenaFile);

  try {
    await fs.access(arenaPath);
    await SceneLoader.AppendAsync(`http://localhost:${PORT}/assets/`, arenaFile, scene);
    console.log(`Loaded arena: ${arenaFile}`);
  } catch {
    console.log(`No arena GLB at public/assets/${arenaFile}; starting with empty scene.`);
  }

  if (level.config) {
    const configPath = path.join(assetsDir, level.config);
    try {
      const raw = await fs.readFile(configPath, "utf8");
      const config = JSON.parse(raw);
      spawnObjectsFromConfig(config);
      console.log(`Spawned ${gameObjects.size} objects from ${level.config}`);
    } catch (error) {
      console.error(`Failed to read level config ${level.config}:`, error.message);
    }
  }

  for (const object of gameObjects.values()) {
    console.log(
      `  ${object.id}: pos=(${object.x.toFixed(2)}, ${object.y.toFixed(2)}, ${object.z.toFixed(2)}) half=(${object.halfX.toFixed(2)}, ${object.halfY.toFixed(2)}, ${object.halfZ.toFixed(2)}) player=${object.player}`,
    );
  }
}

export async function reloadLevel(level) {
  clearScene();
  gameState.currentLevel = level;
  await loadLevelIfPresent(level);
}
```

- [ ] **Step 2: Verify syntax**

Run: `node --check server/game/level.js`
Expected: No output

- [ ] **Step 3: Commit**

```bash
git add server/game/level.js
git commit -m "feat: rewrite server level loading with config-driven spawning from templates"
```

---

### Task 5: Server integration — startup & welcome message

**Files:**
- Modify: `server/index.js:115-118`
- Modify: `server/net/connections.js:1-21`

- [ ] **Step 1: Add template registry init to server startup**

In `server/index.js`, add the import at the top (after existing imports around line 11):

```js
import { initTemplateRegistry } from "./game/templateRegistry.js";
```

Then insert `await initTemplateRegistry();` between `enableHavokPhysics()` and `discoverLevels()` (between current lines 115-116):

```js
await enableHavokPhysics();
await initTemplateRegistry();
await discoverLevels();
```

- [ ] **Step 2: Add templates to welcome message**

In `server/net/connections.js`, add the import at the top:

```js
import { getAllPaths } from "../game/templateRegistry.js";
```

Update the welcome message (lines 15-21) to include `templates`:

```js
    socket.send(JSON.stringify({
      type: "welcome",
      clientId,
      playerId,
      tickRate: TICK_RATE,
      level: gameState.currentLevel?.url ?? "/assets/levels/level1.glb",
      templates: getAllPaths(),
    }));
```

- [ ] **Step 3: Verify syntax**

Run: `node --check server/index.js && node --check server/net/connections.js`
Expected: No output

- [ ] **Step 4: Commit**

```bash
git add server/index.js server/net/connections.js
git commit -m "feat: wire up template registry startup and include templates in welcome message"
```

---

### Task 6: Server type detection & wire protocol

**Files:**
- Modify: `server/game/entities.js`

- [ ] **Step 1: Update type detection functions to use ID prefix checks**

In `server/game/entities.js`, replace the type detection functions (lines 27-54). Remove `isDynamicName` (lines 27-33), `isLeftSideTrebuchetName` (lines 47-50), and `sideSignForTrebuchet` (lines 52-54) entirely — all three are dead code after `registration.js` is deleted.

Replace `isTrebuchetName`, `isMissileName`, and `isKingName` (lines 35-45) with prefix checks:

```js
export function isTrebuchetName(name) {
  return name.startsWith("trebuchets/");
}

export function isMissileName(name) {
  return name.startsWith("missiles/");
}

export function isKingName(name) {
  return name.startsWith("kings/");
}
```

- [ ] **Step 2: Update constrainedPointForObject to use object.player**

Replace `constrainedPointForObject` (lines 101-125) with:

```js
export function constrainedPointForObject(object, point, clientId = null) {
  if (!isTrebuchetName(object.id)) {
    let x = Number(point.x);
    if (clientId === 1) x = Math.min(x, 0);
    if (clientId === 2) x = Math.max(x, 0);
    return {
      x,
      y: Number(point.y ?? object.y),
      z: Number(point.z),
    };
  }

  const minX = object.player === 1
    ? BARRAGE_CONFIG.trebuchetLeftMinX
    : BARRAGE_CONFIG.trebuchetRightMinX;
  const maxX = object.player === 1
    ? BARRAGE_CONFIG.trebuchetLeftMaxX
    : BARRAGE_CONFIG.trebuchetRightMaxX;

  return {
    x: clamp(Number(point.x), minX, maxX),
    y: object.originY,
    z: object.originZ,
  };
}
```

- [ ] **Step 3: Add player field to toWireObject**

Replace `toWireObject` (lines 10-25) with:

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

- [ ] **Step 4: Remove sideSignForTrebuchet import from trebuchet.js**

In `server/game/trebuchet.js`, remove `sideSignForTrebuchet` from the import on line 6:

```js
import {
  isTrebuchetName,
  isMissileName,
  restArmAngleForTrebuchet,
  releaseVelocityForObject,
  trebuchetFireVelocityMax,
  ARM_STATE_IDLE,
  ARM_STATE_RELEASING,
  ARM_STATE_RETURNING,
} from "./entities.js";
```

- [ ] **Step 5: Remove isLeftSideTrebuchetName import from entities.js consumers**

Check `server/game/drag.js` — its imports from `entities.js` (line 2-10) do NOT include `isLeftSideTrebuchetName` or `sideSignForTrebuchet`, so no change needed there.

Check `server/game/registration.js` — this file will be deleted in Task 12. No change needed now.

- [ ] **Step 6: Verify syntax**

Run: `node --check server/game/entities.js && node --check server/game/trebuchet.js`
Expected: No output

- [ ] **Step 7: Commit**

```bash
git add server/game/entities.js server/game/trebuchet.js
git commit -m "feat: switch type detection to ID prefix checks, add player to wire protocol"
```

---

### Task 7: Server player ownership & game rules

**Files:**
- Modify: `server/game/drag.js:49-52`
- Modify: `server/game/input.js:39-42`
- Modify: `server/game/trebuchet.js:177`
- Modify: `server/game/rules.js:22,65-67`

- [ ] **Step 1: Add trebuchet ownership guard in drag.js**

In `server/game/drag.js`, replace the non-trebuchet check in `handleDragStart` (lines 49-52):

```js
  if (!isTrebuchetName(object.id)) {
    if (client.id === 1 && object.x > 2) return;
    if (client.id === 2 && object.x < -2) return;
  }
```

with:

```js
  if (isTrebuchetName(object.id)) {
    if (object.player && object.player !== client.id) return;
  } else {
    if (client.id === 1 && object.x > 2) return;
    if (client.id === 2 && object.x < -2) return;
  }
```

- [ ] **Step 2: Add aim ownership guard in input.js**

In `server/game/input.js`, add one line after the trebuchet null/state check (after line 40):

```js
    const trebuchet = gameObjects.get(missile.loadedInto);
    if (!trebuchet || !trebuchet.loaded || trebuchet.fireState === ARM_STATE_RELEASING) return;
    if (trebuchet.player && trebuchet.player !== client.id) return;
```

The new line is the third line above.

- [ ] **Step 3: Update fire direction in trebuchet.js**

In `server/game/trebuchet.js`, replace line 177:

```js
  const shotDirectionX = sideSignForTrebuchet(trebuchet.id);
```

with:

```js
  const shotDirectionX = trebuchet.player === 1 ? 1 : -1;
```

- [ ] **Step 4: Update playerIdForKing in rules.js**

In `server/game/rules.js`, replace `playerIdForKing` (lines 65-67):

```js
export function playerIdForKing(king) {
  return king.originX < 0 ? "P1" : "P2";
}
```

with:

```js
export function playerIdForKing(king) {
  return king.player === 1 ? "P1" : "P2";
}
```

- [ ] **Step 5: Update resetGameState to use originRot**

In `server/game/rules.js`, replace line 22:

```js
    object.rot = 0;
```

with:

```js
    object.rot = object.originRot ?? 0;
```

- [ ] **Step 6: Verify syntax**

Run: `node --check server/game/drag.js && node --check server/game/input.js && node --check server/game/trebuchet.js && node --check server/game/rules.js`
Expected: No output

- [ ] **Step 7: Commit**

```bash
git add server/game/drag.js server/game/input.js server/game/trebuchet.js server/game/rules.js
git commit -m "feat: add trebuchet ownership guards, player-based fire direction and king attribution"
```

---

### Task 8: Client template registry

**Files:**
- Create: `public/client/templateRegistry.js`

- [ ] **Step 1: Create the client template registry**

Create `public/client/templateRegistry.js`:

```js
import { scene } from "./engine.js";

const { SceneLoader } = BABYLON;

const templateCache = new Map();

export async function initTemplateRegistry(templatePaths) {
  for (const templatePath of templatePaths) {
    const before = new Set(scene.rootNodes);
    await SceneLoader.AppendAsync("/assets/templates/", `${templatePath}.glb`, scene);
    const newRoot = scene.rootNodes.find((n) => !before.has(n));
    newRoot.name = `__template_${templatePath}__`;
    newRoot.setEnabled(false);
    templateCache.set(templatePath, newRoot);
    console.log(`Template loaded: ${templatePath}`);
  }
}

export function getTemplateRoot(templatePath) {
  return templateCache.get(templatePath);
}
```

- [ ] **Step 2: Commit**

```bash
git add public/client/templateRegistry.js
git commit -m "feat: add client template registry for loading and caching template GLBs"
```

---

### Task 9: Client level rewrite — arena-only load & lazy cloning

**Files:**
- Modify: `public/client/level.js`

- [ ] **Step 1: Rewrite level.js**

Replace the entire contents of `public/client/level.js`:

```js
import { engine, scene, canvas, CONFIG } from "./engine.js";
import { childRole, descendantsOf, isTrebuchetArmRoot, findTrebuchetArmAncestor, isMissileName, colliderNodesFor } from "./utils.js";
import { visualObjects, visualBaseRotations, trebuchetArmNodes, trebuchetLoadTargets, latestObjectStates, findGameplayRoot } from "./state.js";
import { createAimArrowMeshes } from "./aim.js";
import { getTemplateRoot } from "./templateRegistry.js";

const {
  ArcRotateCamera,
  Color3,
  HemisphericLight,
  MeshBuilder,
  SceneLoader,
  ShadowGenerator,
  StandardMaterial,
  Vector3,
} = BABYLON;

let activeShadowGenerator = null;

function ensureCameraAndLight() {
  if (scene.cameras.length > 0) {
    scene.activeCamera = scene.cameras[0];
  } else {
    scene.activeCamera = new ArcRotateCamera("FallbackCamera", Math.PI / 2, Math.PI / 3, 14, Vector3.Zero(), scene);
  }

  if (CONFIG.cameraControlsEnabled) {
    scene.activeCamera.attachControl(canvas, true);
  } else {
    scene.activeCamera.detachControl();
  }

  if (scene.lights.length === 0) {
    const fallbackLight = new HemisphericLight("FallbackLight", new Vector3(0, 1, 0), scene);
    fallbackLight.intensity = CONFIG.fallbackLightIntensity ?? 0.8;
  } else {
    const scale = CONFIG.importedLightIntensityScale ?? 1.0;
    for (const light of scene.lights) {
      light.intensity *= scale;
    }
  }

  console.info("Scene setup", {
    activeCamera: scene.activeCamera.name,
    cameraControlsEnabled: Boolean(CONFIG.cameraControlsEnabled),
    cameras: scene.cameras.map((camera) => camera.name),
    lights: scene.lights.map((light) => ({ name: light.name, intensity: light.intensity })),
  });
}

let missilePickColliderMat = null;

function boundsForVisualNodes(nodes) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (const node of nodes) {
    if (typeof node.getHierarchyBoundingVectors !== "function") continue;
    const b = node.getHierarchyBoundingVectors(true);
    minX = Math.min(minX, b.min.x);
    minY = Math.min(minY, b.min.y);
    minZ = Math.min(minZ, b.min.z);
    maxX = Math.max(maxX, b.max.x);
    maxY = Math.max(maxY, b.max.y);
    maxZ = Math.max(maxZ, b.max.z);
  }

  if (!Number.isFinite(minX)) return null;
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

function maxWorldScale(node) {
  const m = node.getWorldMatrix().m;
  return Math.max(
    Math.hypot(m[0], m[1], m[2]),
    Math.hypot(m[4], m[5], m[6]),
    Math.hypot(m[8], m[9], m[10]),
    0.0001,
  );
}

export function createMissilePickCollider(root) {
  const scale = CONFIG.missilePickColliderScale ?? 1;
  if (scale <= 1) return;

  const bounds = boundsForVisualNodes(colliderNodesFor(root));
  if (!bounds) return;

  if (!missilePickColliderMat) {
    missilePickColliderMat = new StandardMaterial("MissilePickColliderMat", scene);
    missilePickColliderMat.disableLighting = true;
  }

  const sizeX = (bounds.maxX - bounds.minX) * scale;
  const sizeY = (bounds.maxY - bounds.minY) * scale;
  const sizeZ = (bounds.maxZ - bounds.minZ) * scale;
  const ws = maxWorldScale(root);

  const pickCollider = MeshBuilder.CreateBox(`${root.name}-PickCollider`, {
    width: Math.max(sizeX, 0.1) / ws,
    height: Math.max(sizeY, 0.1) / ws,
    depth: Math.max(sizeZ, 0.1) / ws,
  }, scene);

  const center = new Vector3(
    (bounds.minX + bounds.maxX) / 2,
    (bounds.minY + bounds.maxY) / 2,
    (bounds.minZ + bounds.maxZ) / 2,
  );
  const worldToRoot = root.getWorldMatrix().clone().invert();

  pickCollider.parent = root;
  pickCollider.position = Vector3.TransformCoordinates(center, worldToRoot);
  pickCollider.material = missilePickColliderMat;
  pickCollider.visibility = 0;
  pickCollider.isPickable = true;
  pickCollider.receiveShadows = false;
}

function isShadowCapableLight(light) {
  return light.getClassName() !== "HemisphericLight";
}

function shouldReceiveShadows(mesh) {
  const name = mesh.name.toLowerCase();
  return name.includes("ground") || name.includes("plane");
}

function setupShadows() {
  activeShadowGenerator = null;

  if (!CONFIG.shadowsEnabled) return;

  const light = scene.lights.find(isShadowCapableLight);
  if (!light) {
    console.info("Shadows disabled: no shadow-capable light found.");
    return;
  }

  const shadowGenerator = new ShadowGenerator(CONFIG.shadowMapSize ?? 2048, light);
  shadowGenerator.useBlurExponentialShadowMap = true;
  shadowGenerator.blurKernel = 16;
  shadowGenerator.bias = CONFIG.shadowBias ?? 0.0005;
  shadowGenerator.normalBias = CONFIG.shadowNormalBias ?? 0.02;

  for (const mesh of scene.meshes) {
    if (!mesh.getTotalVertices || mesh.getTotalVertices() === 0) continue;

    const role = childRole(mesh.name);
    if (role === "Col") {
      mesh.receiveShadows = false;
      continue;
    }

    mesh.receiveShadows = shouldReceiveShadows(mesh);

    if (role === "Vis" || role === "ColVis") {
      shadowGenerator.addShadowCaster(mesh, true);
    }
  }

  activeShadowGenerator = shadowGenerator;

  console.info("Shadows enabled", {
    light: light.name,
    casters: shadowGenerator.getShadowMap().renderList.length,
    mapSize: CONFIG.shadowMapSize ?? 2048,
  });
}

function templatePathFromId(objectId) {
  const lastUnderscore = objectId.lastIndexOf("_");
  if (lastUnderscore < 0) return objectId;
  return objectId.substring(0, lastUnderscore);
}

function registerCloneShadows(clone) {
  if (!activeShadowGenerator) return;
  const descendants = descendantsOf(clone);
  for (const node of descendants) {
    if (!node.getTotalVertices || node.getTotalVertices() === 0) continue;
    const role = childRole(node.name);
    if (role === "Vis" || role === "ColVis") {
      activeShadowGenerator.addShadowCaster(node, true);
    }
    if (role === "Col") {
      if (node.setEnabled) node.setEnabled(false);
    }
    node.receiveShadows = shouldReceiveShadows(node);
  }
}

export function ensureVisualsForState(objects) {
  let created = false;

  for (const obj of objects) {
    if (visualObjects.has(obj.id)) continue;

    const templatePath = templatePathFromId(obj.id);
    const templateRoot = getTemplateRoot(templatePath);
    if (!templateRoot) continue;

    const clone = templateRoot.clone(obj.id);
    clone.name = obj.id;
    clone.setEnabled(true);
    clone.position.set(obj.x, obj.y, obj.z);

    visualObjects.set(obj.id, clone);
    visualBaseRotations.set(obj.id, { x: 0, y: 0, z: 0 });

    const descendants = descendantsOf(clone);
    for (const node of descendants) {
      const role = childRole(node.name);
      if (role === "Col" && node.setEnabled) {
        node.setEnabled(false);
      }
    }

    if (obj.id.startsWith("trebuchets/")) {
      for (const node of descendants) {
        if (isTrebuchetArmRoot(node)) {
          trebuchetArmNodes.set(obj.id, node);
          break;
        }
      }
      for (const node of descendants) {
        if (node.name.toLowerCase().includes("missile-load-target")) {
          trebuchetLoadTargets.set(obj.id, {
            targetNode: node,
            rootNode: clone,
            armNode: trebuchetArmNodes.get(obj.id) ?? null,
          });
          break;
        }
      }
    }

    if (obj.id.startsWith("missiles/")) {
      createMissilePickCollider(clone);
    }

    registerCloneShadows(clone);
    created = true;
  }

  return created;
}

function clearLevel() {
  // dispose(false, false): do NOT dispose shared materials/textures — templates reuse them
  for (const visual of visualObjects.values()) {
    visual.dispose(false, false);
  }
  visualObjects.clear();
  visualBaseRotations.clear();
  trebuchetArmNodes.clear();
  trebuchetLoadTargets.clear();
  latestObjectStates.clear();

  for (const generator of scene.shadowGenerators?.slice() ?? []) {
    generator.dispose();
  }
  activeShadowGenerator = null;

  const arenaRoots = scene.rootNodes.filter((n) => n.name === "__root__");
  for (const root of arenaRoots) {
    root.dispose(false, true);
  }
}

export async function loadLevel(url) {
  if (!url) return;

  try {
    await SceneLoader.AppendAsync("", url, scene);
  } catch (error) {
    console.error("Failed to load arena GLB:", error);
  }

  ensureCameraAndLight();
  setupShadows();
  createAimArrowMeshes();
  engine.resize();
}

export async function reloadLevel(url) {
  engine.stopRenderLoop();
  clearLevel();
  await loadLevel(url);
  engine.runRenderLoop(() => scene.render());
}
```

- [ ] **Step 2: Commit**

```bash
git add public/client/level.js
git commit -m "feat: rewrite client level loading with arena-only load and lazy template cloning"
```

---

### Task 10: Client startup flow & network

**Files:**
- Modify: `public/client/index.js`
- Modify: `public/client/network.js`

- [ ] **Step 1: Simplify index.js — remove direct loadLevel call**

Replace the entire contents of `public/client/index.js`:

```js
import { engine } from "./engine.js";
import { setupInput } from "./input.js";
import "./network.js";
import "./aim.js";

setupInput();

window.addEventListener("resize", () => {
  engine.resize();
});
```

- [ ] **Step 2: Update network.js — async message handler with ready gate**

Replace the entire contents of `public/client/network.js`:

```js
import { connectionEl, playerEl, scoreLeftEl, scoreRightEl, matchEndEl, matchEndTextEl, rematchEl, engine, scene } from "./engine.js";
import { applyState } from "./state.js";
import { loadLevel, reloadLevel, ensureVisualsForState } from "./level.js";

let seq = 0;
let displayedScores = { P1: 0, P2: 0 };
let ready = false;

const socketProtocol = window.location.protocol === "https:" ? "wss" : "ws";
export const socket = new WebSocket(`${socketProtocol}://${window.location.host}`);

function spawnFlyingStar(side) {
  const container = side === "left" ? scoreLeftEl : scoreRightEl;
  const color = side === "left" ? "#ff6b6b" : "#6ba3ff";

  const star = document.createElement("span");
  star.className = "score-star-flying";
  star.textContent = "★";
  star.style.color = color;
  document.body.appendChild(star);

  const targetRect = container.getBoundingClientRect();
  const starCount = container.children.length;
  const targetX = side === "left"
    ? targetRect.left + starCount * 32 + 14
    : targetRect.right - starCount * 32 - 14;
  const targetY = targetRect.top + targetRect.height / 2;

  const animation = star.animate([
    {
      top: "50%", left: "50%",
      fontSize: "120px",
      transform: "translate(-50%, -50%)",
      opacity: 1,
    },
    {
      top: "50%", left: "50%",
      fontSize: "120px",
      transform: "translate(-50%, -50%)",
      opacity: 1,
      offset: 0.4,
    },
    {
      top: `${targetY}px`, left: `${targetX}px`,
      fontSize: "28px",
      transform: "translate(-50%, -50%)",
      opacity: 1,
    },
  ], {
    duration: 1400,
    easing: "ease-in-out",
    fill: "forwards",
  });

  animation.onfinish = () => {
    star.remove();
    const settled = document.createElement("span");
    settled.className = "score-star";
    settled.textContent = "★";
    container.appendChild(settled);
  };
}

function updateScores(scores, animate) {
  if (!scores) return;
  const p1 = scores.P1 ?? 0;
  const p2 = scores.P2 ?? 0;
  if (p1 === displayedScores.P1 && p2 === displayedScores.P2) return;

  if (animate) {
    if (p1 > displayedScores.P1) spawnFlyingStar("left");
    if (p2 > displayedScores.P2) spawnFlyingStar("right");
  } else {
    while (scoreLeftEl.children.length < p1) {
      const s = document.createElement("span");
      s.className = "score-star";
      s.textContent = "★";
      scoreLeftEl.appendChild(s);
    }
    while (scoreRightEl.children.length < p2) {
      const s = document.createElement("span");
      s.className = "score-star";
      s.textContent = "★";
      scoreRightEl.appendChild(s);
    }
  }

  displayedScores = { P1: p1, P2: p2 };
}

socket.addEventListener("open", () => {
  connectionEl.textContent = "Connected";
});

socket.addEventListener("message", async (event) => {
  const message = JSON.parse(event.data);

  if (message.type === "welcome") {
    playerEl.textContent = message.playerId;
    const { initTemplateRegistry } = await import("./templateRegistry.js");
    await initTemplateRegistry(message.templates ?? []);
    await loadLevel(message.level);
    engine.runRenderLoop(() => { scene.render(); });
    ready = true;
    return;
  }

  if (!ready) return;

  if (message.type === "roundEnded") {
    updateScores(message.scores, true);
  }

  if (message.type === "roundStarted") {
    if (message.level) reloadLevel(message.level);
  }

  if (message.type === "matchEnded") {
    updateScores(message.scores, false);
    const color = message.winner === "P1" ? "#ff6b6b" : "#6ba3ff";
    matchEndTextEl.textContent = "👑";
    matchEndTextEl.style.color = color;
    matchEndEl.classList.remove("hidden");
  }

  if (message.type === "matchReset") {
    matchEndEl.classList.add("hidden");
    scoreLeftEl.innerHTML = "";
    scoreRightEl.innerHTML = "";
    displayedScores = { P1: 0, P2: 0 };
    if (message.level) reloadLevel(message.level);
  }

  if (message.type === "state") {
    updateScores(message.scores, false);
    ensureVisualsForState(message.objects ?? []);
    applyState(message);
  }
});

socket.addEventListener("close", () => {
  connectionEl.textContent = "Disconnected";
});

rematchEl.addEventListener("click", () => {
  sendInput("reset");
});

export function sendInput(action, payload) {
  if (socket.readyState !== WebSocket.OPEN) return;

  socket.send(JSON.stringify({
    type: "input",
    seq: ++seq,
    action,
    ...payload,
  }));
}
```

- [ ] **Step 3: Commit**

```bash
git add public/client/index.js public/client/network.js
git commit -m "feat: update client startup flow with async welcome handler and ready gate"
```

---

### Task 11: Client player-based aim & type detection

**Files:**
- Modify: `public/client/utils.js:72-79,95-101`
- Modify: `public/client/aim.js:142`

- [ ] **Step 1: Update type detection functions in client utils.js**

In `public/client/utils.js`, replace `isMissileName` (lines 32-34):

```js
export function isMissileName(name) {
  return name.toLowerCase().includes("missile");
}
```

with:

```js
export function isMissileName(name) {
  return name.startsWith("missiles/");
}
```

Replace `isTrebuchetName` (lines 72-74):

```js
export function isTrebuchetName(name) {
  return name.toLowerCase().includes("trebuche");
}
```

with:

```js
export function isTrebuchetName(name) {
  return name.startsWith("trebuchets/");
}
```

- [ ] **Step 2: Remove isLeftSideTrebuchetName and update isForwardPullPoint**

Remove `isLeftSideTrebuchetName` (lines 76-79) entirely.

Replace `isForwardPullPoint` (lines 95-101):

```js
export function isForwardPullPoint(trebuchetId, point, releasePoint) {
  if (isLeftSideTrebuchetName(trebuchetId)) {
    return point.x > releasePoint.x;
  }

  return point.x < releasePoint.x;
}
```

with:

```js
export function isForwardPullPoint(trebuchetState, point, releasePoint) {
  if (trebuchetState.player === 1) {
    return point.x > releasePoint.x;
  }
  return point.x < releasePoint.x;
}
```

- [ ] **Step 3: Update aim.js call site**

In `public/client/aim.js`, replace line 142:

```js
  if (!isForwardPullPoint(trebuchetId, aimWorldPoint, headPoint)) {
```

with:

```js
  const trebuchetState = latestObjectStates.get(trebuchetId);
  if (!trebuchetState || !isForwardPullPoint(trebuchetState, aimWorldPoint, headPoint)) {
```

- [ ] **Step 4: Commit**

```bash
git add public/client/utils.js public/client/aim.js
git commit -m "feat: switch client to player-based aim direction and prefix type detection"
```

---

### Task 12: Cleanup — remove registration.js & dead code

**Files:**
- Delete: `server/game/registration.js`
- Modify: `server/game/level.js` (remove import if still present)

- [ ] **Step 1: Delete registration.js**

```bash
git rm server/game/registration.js
```

- [ ] **Step 2: Verify no remaining imports of registration.js**

```bash
grep -r "registration" server/ --include="*.js"
```

Expected: No results. The old `level.js` import of `registration.js` was removed in Task 4 when level.js was rewritten.

- [ ] **Step 3: Remove "default" fallback from loadTargetForTrebuchet**

In `server/game/trebuchet.js`, replace line 74:

```js
  const target = loadTargets.get(trebuchet.id) ?? loadTargets.get("default") ?? null;
```

with:

```js
  const target = loadTargets.get(trebuchet.id) ?? null;
```

The `"default"` key was populated by the old `registerMeshRoots`. Every trebuchet now gets an explicit `loadTargets` entry keyed by its generated ID.

- [ ] **Step 4: Remove isDynamicName import from registration.js consumers**

Check for any remaining imports of `isDynamicName` in the codebase:

```bash
grep -r "isDynamicName" server/ public/client/ --include="*.js"
```

Expected: Only the now-deleted `registration.js` imported it. If any file still imports it, remove the import.

- [ ] **Step 5: Verify no remaining references to removed functions**

```bash
grep -r "isLeftSideTrebuchetName\|sideSignForTrebuchet\|registerMeshRoots\|registerVisualRoots\|registerTrebuchetArmNodes\|registerTrebuchetLoadTargets\|isDynamicName" server/ public/client/ --include="*.js"
```

Expected: No results.

- [ ] **Step 6: Commit**

```bash
git rm server/game/registration.js
git add server/game/trebuchet.js
git commit -m "chore: remove registration.js, dead code, and loadTargets default fallback"
```

---

## Manual Integration Test

After all tasks are complete and template GLBs are exported from Blender:

1. Start the server: `node server/index.js`
2. Check server logs for: template loading messages, level config spawning, object positions with player fields
3. Open browser to `http://localhost:3000`
4. Verify: arena renders, objects appear at config positions, blocks at ±12, trebuchets at ±25, kings at ±37
5. Test drag: P1 can drag P1's trebuchet but NOT P2's trebuchet
6. Test aim: P1 can aim P1's trebuchet but NOT P2's trebuchet
7. Test fire direction: P1 trebuchet fires right, P2 fires left
8. Knock over a king, verify correct player wins
9. Play through multiple rounds, verify level transitions preserve templates (no re-download)
10. Check browser console for errors during round transitions
