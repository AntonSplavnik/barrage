# Server Refactoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize `server/` into `game/` and `net/` directories AND break down oversized files so each module has one focused responsibility.

**Architecture:** Two axes of change: (1) directory structure separates server infra from game logic from networking, (2) internal decomposition splits bloated files — `input.js` gets drag handlers extracted, `simulation.js` loses trebuchet animation to `trebuchet.js`, `level.js` splits mesh registration into its own module, `utils.js` splits into `math.js` + `entities.js`, and `state.js`/`physics.js` merge engine setup into one `game/physics.js`. No behavior changes.

**Tech Stack:** Node.js 20+, ES modules, Babylon.js (headless NullEngine), Havok Physics WASM, Express, WebSocket (`ws`)

**Verification:** No test suite exists. After each task: `node server/index.js` — server should start, print loaded level info, accept connections. Kill with Ctrl+C.

---

## Target Structure

```
server/
├── index.js              — HTTP server, static files, admin restart, startup
├── config.js             — PORT, TICK_RATE, TICK_MS, SERVER_CONFIG (unchanged)
├── math.js               — pure math (clamp, lerp, angles, rotations)
│
├── game/
│   ├── state.js          — game data Maps + gameState
│   ├── entities.js       — entity types, ARM states, wire format, world constraints
│   ├── physics.js        — NullEngine, Scene, Havok init, physicsAggregates, body ops
│   ├── loop.js           — game tick interval
│   ├── rules.js          — round/match logic, resetGameState, resetMatch
│   ├── input.js          — input dispatcher (thin router to drag/trebuchet)
│   ├── drag.js           — drag start/move/end + velocity calculation
│   ├── simulation.js     — physics step orchestration (pre → step → sync)
│   ├── trebuchet.js      — load, aim, fire, release + arm animation
│   ├── level.js          — GLB loading, scene clear, reload
│   ├── registration.js   — mesh scanning → game objects, bounds calculation
│   └── levelCatalog.js   — level discovery
│
└── net/
    ├── broadcast.js      — broadcast(), sendState()
    └── connections.js    — WebSocket lifecycle
```

**What changed internally (not just moved):**

| Old file | Problem | New split |
|----------|---------|-----------|
| `utils.js` (290 lines) | 7+ concerns in one grab bag | `math.js` + `game/entities.js` + bounds inlined into `game/registration.js` |
| `input.js` (241 lines) | 150-line `applyInput` monolith + misplaced `resetGameState` | `game/input.js` (thin dispatcher ~80 lines) + `game/drag.js` (~120 lines) + `resetGameState` → `game/rules.js` |
| `simulation.js` (152 lines) | Trebuchet arm animation mixed with physics step | `updateTrebuchetFireState` moves to `game/trebuchet.js`. `game/simulation.js` is pure physics orchestration (~75 lines) |
| `level.js` (205 lines) | Loading + mesh registration + would get bounds inlined = 300+ lines | `game/level.js` (loading/clearing ~75 lines) + `game/registration.js` (mesh→objects + bounds ~160 lines) |
| `state.js` + `physics.js` | Engine setup split across two files | Merged into `game/physics.js` (~160 lines). `game/state.js` is pure data (~15 lines) |
| `index.js` (161 lines) | Server + WebSocket + game loop all in one | `index.js` (server only ~90 lines) + `net/connections.js` + `game/loop.js` |
| `gameManager.js` | Circular dep with input.js | Becomes `game/rules.js` with `resetGameState` moved in. Circular dep eliminated. |

---

### Task 1: Create foundation modules

Leaf modules with no cross-dependencies. Bridge old files so existing imports keep working.

**Files:**
- Create: `server/math.js`
- Create: `server/game/entities.js`
- Create: `server/game/state.js`
- Modify: `server/utils.js` (bridge)
- Modify: `server/state.js` (bridge)

- [ ] **Step 1: Create directories**

```bash
mkdir -p server/game server/net
```

- [ ] **Step 2: Create `server/math.js`**

```javascript
import { Quaternion } from "@babylonjs/core/Maths/math.vector.js";

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function clampVector(vector, maxMagnitude) {
  const magnitude = Math.hypot(vector.x, vector.y, vector.z);
  if (magnitude <= maxMagnitude || magnitude === 0) return vector;

  const scale = maxMagnitude / magnitude;
  return {
    x: vector.x * scale,
    y: vector.y * scale,
    z: vector.z * scale,
  };
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function shortestAngleDeltaDegrees(from, to) {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

export function lerpAngleDegrees(from, to, t) {
  return from + shortestAngleDeltaDegrees(from, to) * t;
}

export function protocolToBabylonRotation(rotDegrees) {
  return -(rotDegrees * Math.PI) / 180;
}

export function babylonToProtocolRotationZ(radians) {
  return -(radians * 180) / Math.PI;
}

export function rotationQuaternionForObject(object) {
  return Quaternion.FromEulerAngles(0, 0, protocolToBabylonRotation(object.rot ?? 0));
}
```

- [ ] **Step 3: Create `server/game/entities.js`**

Entity type checks, ARM state constants, wire serialization, and game constraint functions.

```javascript
import { BARRAGE_CONFIG } from "../../public/config.js";
import { SERVER_CONFIG } from "../config.js";
import { clamp, clampVector } from "../math.js";

export const ARM_STATE_IDLE = "idle";
export const ARM_STATE_AIMING = "aiming";
export const ARM_STATE_RELEASING = "releasing";
export const ARM_STATE_RETURNING = "returning";

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
    ...(object.loaded !== undefined ? { loaded: object.loaded } : {}),
    ...(object.loadedInto ? { loadedInto: object.loadedInto } : {}),
    ...(object.armAngle !== undefined ? { armAngle: object.armAngle, fireState: object.fireState } : {}),
    ...(object.hits !== undefined ? { hits: object.hits, maxHits: object.maxHits } : {}),
  };
}

export function isDynamicName(name) {
  const lowerName = name.toLowerCase();
  return lowerName.includes("block")
    || lowerName.includes("trebuche")
    || lowerName.includes("missile")
    || lowerName.includes("king");
}

export function isTrebuchetName(name) {
  return name.toLowerCase().includes("trebuche");
}

export function isMissileName(name) {
  return name.toLowerCase().includes("missile");
}

export function isKingName(name) {
  return name.toLowerCase().includes("king");
}

export function isLeftSideTrebuchetName(name) {
  const lowerName = name.toLowerCase();
  return lowerName.includes("p1") || lowerName.includes("left") || lowerName.includes("1");
}

export function sideSignForTrebuchet(name) {
  return isLeftSideTrebuchetName(name) ? 1 : -1;
}

export function restArmAngleForTrebuchet() {
  return BARRAGE_CONFIG.trebuchetArmRestRotationZDegrees ?? 15;
}

export function normalReleaseVelocityMax() {
  return BARRAGE_CONFIG.normalReleaseVelocityMax
    ?? BARRAGE_CONFIG.releaseVelocityMax
    ?? SERVER_CONFIG.releaseVelocityMax;
}

export function trebuchetFireVelocityMax() {
  return BARRAGE_CONFIG.trebuchetFireVelocityMax
    ?? SERVER_CONFIG.releaseVelocityMax;
}

export function releaseVelocityForObject(object, velocity = {}, maxVelocity = normalReleaseVelocityMax()) {
  const clamped = clampVector({
    x: Number(velocity.x ?? 0),
    y: Number(velocity.y ?? 0),
    z: Number(velocity.z ?? 0),
  }, maxVelocity);

  if (isTrebuchetName(object.id)) {
    return { x: clamped.x, y: 0, z: 0 };
  }

  return clamped;
}

export function constrainWorldBounds(object) {
  object.x = clamp(object.x, SERVER_CONFIG.worldMinX, SERVER_CONFIG.worldMaxX);
  object.z = clamp(object.z, SERVER_CONFIG.worldMinZ, SERVER_CONFIG.worldMaxZ);

  const floorY = SERVER_CONFIG.groundY + object.halfY - (object.offsetY ?? 0);
  if (object.y < floorY) {
    object.y = floorY;
    if (object.vy < 0) object.vy = 0;
  }

  if (object.x === SERVER_CONFIG.worldMinX && object.vx < 0) object.vx = 0;
  if (object.x === SERVER_CONFIG.worldMaxX && object.vx > 0) object.vx = 0;
  if (object.z === SERVER_CONFIG.worldMinZ && object.vz < 0) object.vz = 0;
  if (object.z === SERVER_CONFIG.worldMaxZ && object.vz > 0) object.vz = 0;
}

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

  const minX = isLeftSideTrebuchetName(object.id)
    ? BARRAGE_CONFIG.trebuchetLeftMinX
    : BARRAGE_CONFIG.trebuchetRightMinX;
  const maxX = isLeftSideTrebuchetName(object.id)
    ? BARRAGE_CONFIG.trebuchetLeftMaxX
    : BARRAGE_CONFIG.trebuchetRightMaxX;

  return {
    x: clamp(Number(point.x), minX, maxX),
    y: object.originY,
    z: object.originZ,
  };
}
```

- [ ] **Step 4: Create `server/game/state.js`**

Pure game data. No Babylon engine — that moves to `game/physics.js` in Task 2.

```javascript
export const clients = new Map();
export const gameObjects = new Map();
export const dragState = new Map();
export const loadTargets = new Map();

export const gameState = {
  tick: 0,
  nextClientId: 1,
  roundNumber: 1,
  scores: {},
  paused: false,
  matchOver: false,
  currentLevel: null,
};
```

- [ ] **Step 5: Convert `server/utils.js` to re-export bridge**

Re-exports from new modules. Keeps mesh/bounds functions locally (they move to `game/registration.js` in Task 3).

```javascript
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { isTrebuchetName as _isTrebuchetName } from "./game/entities.js";

export {
  clamp,
  clampVector,
  lerp,
  shortestAngleDeltaDegrees,
  lerpAngleDegrees,
  protocolToBabylonRotation,
  babylonToProtocolRotationZ,
  rotationQuaternionForObject,
} from "./math.js";

export {
  ARM_STATE_IDLE,
  ARM_STATE_AIMING,
  ARM_STATE_RELEASING,
  ARM_STATE_RETURNING,
  toWireObject,
  isDynamicName,
  isTrebuchetName,
  isMissileName,
  isKingName,
  isLeftSideTrebuchetName,
  sideSignForTrebuchet,
  restArmAngleForTrebuchet,
  normalReleaseVelocityMax,
  trebuchetFireVelocityMax,
  releaseVelocityForObject,
  constrainWorldBounds,
  constrainedPointForObject,
} from "./game/entities.js";

export function childRole(name) {
  if (name.includes("ColVis")) return "ColVis";
  if (name.includes("Visual") || name.includes("Vis")) return "Vis";
  if (name.includes("Collider") || name.includes("Col")) return "Col";
  return null;
}

export function isTrebuchetArmName(name) {
  const lowerName = name.toLowerCase();
  return lowerName.includes("trebuche") && lowerName.includes("arm");
}

export function descendantsOf(transform) {
  const descendants = [];
  const stack = [...transform.getChildren()];
  while (stack.length > 0) {
    const child = stack.pop();
    descendants.push(child);
    if (typeof child.getChildren === "function") {
      stack.push(...child.getChildren());
    }
  }
  return descendants;
}

export function isTrebuchetArmRoot(transform) {
  const lowerName = transform.name.toLowerCase();
  return isTrebuchetArmName(transform.name)
    && transform.parent
    && _isTrebuchetName(transform.parent.name)
    && !lowerName.includes("visual")
    && !lowerName.includes("collider")
    && !lowerName.includes("col")
    && descendantsOf(transform).some((child) => child.name.toLowerCase().includes("missile-load-target"));
}

export function boundsForNodes(nodes) {
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

function isNestedTrebuchetArmDescendant(root, node) {
  let current = node.parent;
  while (current && current !== root) {
    if (isTrebuchetArmRoot(current)) return true;
    current = current.parent;
  }
  return false;
}

export function colliderBoundsFor(transform) {
  try {
    const colliderNodes = descendantsOf(transform).filter((child) => {
      const role = childRole(child.name);
      return (role === "Col" || role === "ColVis")
        && !isNestedTrebuchetArmDescendant(transform, child);
    });
    const bounds = boundsForNodes(colliderNodes.length > 0 ? colliderNodes : [transform]);
    const absolutePosition = transform.getAbsolutePosition();
    const centerX = (bounds.min.x + bounds.max.x) / 2;
    const centerY = (bounds.min.y + bounds.max.y) / 2;
    const centerZ = (bounds.min.z + bounds.max.z) / 2;
    return {
      offsetX: centerX - absolutePosition.x,
      offsetY: centerY - absolutePosition.y,
      offsetZ: centerZ - absolutePosition.z,
      halfX: Math.max(0.05, (bounds.max.x - bounds.min.x) / 2),
      halfY: Math.max(0.05, (bounds.max.y - bounds.min.y) / 2),
      halfZ: Math.max(0.05, (bounds.max.z - bounds.min.z) / 2),
    };
  } catch {
    return { offsetX: 0, offsetY: 0, offsetZ: 0, halfX: 0.5, halfY: 0.5, halfZ: 0.5 };
  }
}
```

- [ ] **Step 6: Convert `server/state.js` to re-export bridge**

```javascript
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Scene } from "@babylonjs/core/scene.js";
import "@babylonjs/core/Physics/v2/physicsEngineComponent.js";

export const engine = new NullEngine({
  renderHeight: 1, renderWidth: 1, textureSize: 1, deterministicLockstep: false,
});
export const scene = new Scene(engine);
scene.activeCamera = new FreeCamera("HeadlessCamera", new Vector3(0, 10, -10), scene);

export const physicsAggregates = new Map();

export {
  clients, gameObjects, dragState, loadTargets, gameState,
} from "./game/state.js";
```

- [ ] **Step 7: Verify and commit**

```bash
node server/index.js
# Expected: starts normally. Kill with Ctrl+C.
git add server/math.js server/game/entities.js server/game/state.js server/utils.js server/state.js
git commit -m "refactor: extract foundation modules (math, entities, state)"
```

---

### Task 2: Create game/physics.js (merge engine + body ops)

Merge NullEngine/Scene from `state.js` + all of `physics.js` + `physicsAggregates` into one cohesive `game/physics.js`.

**Files:**
- Create: `server/game/physics.js`
- Modify: `server/state.js` (update bridge)
- Modify: `server/physics.js` (convert to bridge)

- [ ] **Step 1: Create `server/game/physics.js`**

Everything Havok/Babylon in one place: engine setup, physics init, body CRUD, constraints.

```javascript
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera.js";
import { Vector3, Quaternion } from "@babylonjs/core/Maths/math.vector.js";
import { Scene } from "@babylonjs/core/scene.js";
import "@babylonjs/core/Physics/v2/physicsEngineComponent.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin.js";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate.js";
import { PhysicsPrestepType, PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin.js";
import HavokPhysics from "@babylonjs/havok";
import { SERVER_CONFIG } from "../config.js";
import { BARRAGE_CONFIG } from "../../public/config.js";
import { gameObjects } from "./state.js";
import { isTrebuchetName, isMissileName } from "./entities.js";
import { rotationQuaternionForObject, clamp, lerpAngleDegrees } from "../math.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const engine = new NullEngine({
  renderHeight: 1,
  renderWidth: 1,
  textureSize: 1,
  deterministicLockstep: false,
});

export const scene = new Scene(engine);
scene.activeCamera = new FreeCamera("HeadlessCamera", new Vector3(0, 10, -10), scene);

export const physicsAggregates = new Map();

export async function enableHavokPhysics() {
  const wasmBinary = await fs.readFile(
    path.join(__dirname, "../../node_modules/@babylonjs/havok/lib/esm/HavokPhysics.wasm"),
  );
  const havokInterface = await HavokPhysics({ wasmBinary });
  const havokPlugin = new HavokPlugin(true, havokInterface);
  scene.enablePhysics(new Vector3(0, SERVER_CONFIG.gravity, 0), havokPlugin);
}

export function createPhysicsBodies() {
  for (const object of gameObjects.values()) {
    const node = new TransformNode(`physics-${object.id}`, scene);
    node.position.set(object.x, object.y, object.z);
    node.rotationQuaternion = rotationQuaternionForObject(object);

    const shapeType = isMissileName(object.id) ? PhysicsShapeType.SPHERE : PhysicsShapeType.BOX;
    const options = {
      mass: object.dynamic ? object.mass : 0,
      friction: object.friction,
      restitution: object.restitution,
      center: new Vector3(object.offsetX, object.offsetY, object.offsetZ),
      extents: new Vector3(object.halfX * 2, object.halfY * 2, object.halfZ * 2),
      radius: Math.max(object.halfX, object.halfY, object.halfZ),
    };

    const aggregate = new PhysicsAggregate(node, shapeType, options, scene);
    aggregate.body.disablePreStep = true;
    aggregate.body.setLinearDamping(isTrebuchetName(object.id) ? 2.2 : 0.15);
    aggregate.body.setAngularDamping(isTrebuchetName(object.id) ? 10 : 0.55);
    physicsAggregates.set(object.id, aggregate);
  }
}

export function syncPhysicsBodyFromObject(object, velocity = null) {
  const aggregate = physicsAggregates.get(object.id);
  if (!aggregate) return;

  const node = aggregate.transformNode;
  node.position.set(object.x, object.y, object.z);
  node.rotationQuaternion = rotationQuaternionForObject(object);
  node.computeWorldMatrix(true);
  teleportPhysicsBody(aggregate);

  if (velocity) {
    aggregate.body.setLinearVelocity(new Vector3(velocity.x, velocity.y, velocity.z));
  }
}

export function teleportPhysicsBody(aggregate) {
  aggregate.body.setPrestepType(PhysicsPrestepType.TELEPORT);
  aggregate.body._physicsPlugin.setPhysicsBodyTransformation(aggregate.body, aggregate.transformNode);
  aggregate.body.setPrestepType(PhysicsPrestepType.DISABLED);
}

export function setPhysicsBodyTrigger(object, isTrigger) {
  const aggregate = physicsAggregates.get(object.id);
  if (!aggregate?.shape) return;

  aggregate.shape.isTrigger = isTrigger;
}

export function constrainBodyToPlane(object) {
  const aggregate = physicsAggregates.get(object.id);
  if (!aggregate) return;

  const node = aggregate.transformNode;
  const linearVelocity = aggregate.body.getLinearVelocity();
  const angularVelocity = aggregate.body.getAngularVelocity();

  node.position.z = object.originZ;
  linearVelocity.z = 0;

  if (isTrebuchetName(object.id)) {
    node.position.y = object.originY;
    node.rotationQuaternion = rotationQuaternionForObject({ rot: 0 });
    linearVelocity.y = 0;
    angularVelocity.x = 0;
    angularVelocity.y = 0;
    angularVelocity.z = 0;
  } else {
    const euler = node.rotationQuaternion?.toEulerAngles() ?? Vector3.Zero();
    node.rotationQuaternion = Quaternion.FromEulerAngles(0, 0, euler.z);
    angularVelocity.x = 0;
    angularVelocity.y = 0;
  }

  node.computeWorldMatrix(true);
  if (isTrebuchetName(object.id) || Math.abs(node.position.z - object.originZ) > 0.001) {
    teleportPhysicsBody(aggregate);
  }
  aggregate.body.setLinearVelocity(linearVelocity);
  aggregate.body.setAngularVelocity(angularVelocity);
}

export function returnDraggedObjectUpright(object) {
  if (!object.dynamic || isTrebuchetName(object.id) || isMissileName(object.id) || object.loadedInto) return;

  const amount = clamp(BARRAGE_CONFIG.dragUprightLerp ?? 0.25, 0, 1);
  object.rot = lerpAngleDegrees(object.rot ?? 0, 0, amount);

  const aggregate = physicsAggregates.get(object.id);
  if (aggregate) {
    aggregate.body.setAngularVelocity(Vector3.Zero());
  }
}
```

- [ ] **Step 2: Update `server/state.js` bridge**

Replace inline engine/scene with re-exports from `game/physics.js`.

```javascript
export { engine, scene, physicsAggregates } from "./game/physics.js";
export { clients, gameObjects, dragState, loadTargets, gameState } from "./game/state.js";
```

- [ ] **Step 3: Convert `server/physics.js` to bridge**

```javascript
export {
  enableHavokPhysics,
  createPhysicsBodies,
  syncPhysicsBodyFromObject,
  teleportPhysicsBody,
  setPhysicsBodyTrigger,
  constrainBodyToPlane,
  returnDraggedObjectUpright,
} from "./game/physics.js";
```

- [ ] **Step 4: Verify and commit**

```bash
node server/index.js
git add server/game/physics.js server/state.js server/physics.js
git commit -m "refactor: merge engine setup and body ops into game/physics"
```

---

### Task 3: Create all game and network modules

This task creates every remaining new file. Old files still exist alongside (bridges forward imports). Nothing breaks until Task 4 deletes the old files.

**Files:**
- Create: `server/net/broadcast.js`
- Create: `server/net/connections.js`
- Create: `server/game/loop.js`
- Create: `server/game/rules.js`
- Create: `server/game/drag.js`
- Create: `server/game/input.js`
- Create: `server/game/trebuchet.js` (with arm animation from simulation.js)
- Create: `server/game/simulation.js` (without arm animation)
- Create: `server/game/registration.js` (mesh scanning + bounds from utils.js)
- Create: `server/game/level.js`
- Create: `server/game/levelCatalog.js`

- [ ] **Step 1: Create `server/net/broadcast.js`**

```javascript
import { clients, gameObjects, gameState } from "../game/state.js";
import { toWireObject } from "../game/entities.js";

export function broadcast(message) {
  const payload = JSON.stringify(message);
  for (const client of clients.values()) {
    if (client.socket.readyState === client.socket.OPEN) {
      client.socket.send(payload);
    }
  }
}

export function sendState() {
  broadcast({
    type: "state",
    tick: gameState.tick,
    serverTime: Date.now(),
    roundNumber: gameState.roundNumber,
    scores: gameState.scores,
    objects: [...gameObjects.values()].map(toWireObject),
  });
}
```

- [ ] **Step 2: Create `server/net/connections.js`**

```javascript
import { WebSocketServer } from "ws";
import { clients, gameState } from "../game/state.js";
import { TICK_RATE } from "../config.js";
import { applyInput } from "../game/input.js";

export function setupWebSocket(httpServer) {
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (socket) => {
    const clientId = gameState.nextClientId++;
    const playerId = clientId === 1 ? "P1" : clientId === 2 ? "P2" : `Spectator_${clientId}`;
    const client = { id: clientId, playerId, socket };
    clients.set(clientId, client);

    socket.send(JSON.stringify({
      type: "welcome",
      clientId,
      playerId,
      tickRate: TICK_RATE,
      level: gameState.currentLevel?.url ?? `/assets/level1.glb`,
    }));

    socket.on("message", (raw) => {
      try {
        applyInput(client, JSON.parse(raw.toString()));
      } catch (error) {
        socket.send(JSON.stringify({ type: "error", message: "Invalid message JSON" }));
      }
    });

    socket.on("close", () => {
      clients.delete(clientId);
    });
  });

  return wss;
}
```

- [ ] **Step 3: Create `server/game/loop.js`**

```javascript
import { gameState } from "./state.js";
import { TICK_MS } from "../config.js";
import { simulatePhysics } from "./simulation.js";
import { tryRecordRoundWin } from "./rules.js";
import { sendState } from "../net/broadcast.js";

let simulationInterval = null;

export function startGameLoop() {
  simulationInterval = setInterval(() => {
    if (gameState.paused) return;
    gameState.tick += 1;
    simulatePhysics();
    tryRecordRoundWin();
    sendState();
  }, TICK_MS);
}

export function stopGameLoop() {
  if (simulationInterval) {
    clearInterval(simulationInterval);
    simulationInterval = null;
  }
}
```

- [ ] **Step 4: Create `server/game/rules.js`**

Merges `gameManager.js` + `resetGameState` from `input.js`. Fixes the circular dependency.

```javascript
import { BARRAGE_CONFIG } from "../../public/config.js";
import {
  isKingName,
  restArmAngleForTrebuchet,
  ARM_STATE_IDLE,
} from "./entities.js";
import { gameObjects, gameState, dragState } from "./state.js";
import { broadcast } from "../net/broadcast.js";
import { reloadLevel } from "./level.js";
import { nextLevel, firstLevel } from "./levelCatalog.js";
import { syncPhysicsBodyFromObject, setPhysicsBodyTrigger } from "./physics.js";

let roundEndInProgress = false;

export function resetGameState() {
  dragState.clear();

  for (const object of gameObjects.values()) {
    object.x = object.originX;
    object.y = object.originY;
    object.z = object.originZ;
    object.rot = 0;
    object.angularVelocity = 0;
    object.vx = 0;
    object.vy = 0;
    object.vz = 0;
    object.dragVx = 0;
    object.dragVy = 0;
    object.dragVz = 0;
    object.draggedBy = null;

    if (object.loaded !== undefined) object.loaded = false;
    if (object.loadedInto !== undefined) {
      object.loadedInto = null;
      setPhysicsBodyTrigger(object, false);
    }
    if (object.armAngle !== undefined) object.armAngle = restArmAngleForTrebuchet();
    if (object.fireState !== undefined) object.fireState = ARM_STATE_IDLE;
    if (object.loadedMissileId !== undefined) object.loadedMissileId = null;
    if (object.aimedBy !== undefined) object.aimedBy = null;
    if (object.aimStart !== undefined) object.aimStart = null;
    if (object.aimCurrent !== undefined) object.aimCurrent = null;
    if (object.pendingShot !== undefined) object.pendingShot = null;
    if (object.returnStartArmAngle !== undefined) object.returnStartArmAngle = null;
    if (object.releaseElapsedMs !== undefined) object.releaseElapsedMs = 0;

    if (object.hits !== undefined) {
      object.hits = 0;
    }

    syncPhysicsBodyFromObject(object, { x: 0, y: 0, z: 0 });
  }
}

export function checkKingKnockout() {
  const threshold = BARRAGE_CONFIG.kingKnockoutAngle ?? 45;
  for (const object of gameObjects.values()) {
    if (isKingName(object.id) && Math.abs(object.rot) >= threshold) {
      return object;
    }
  }
  return null;
}

export function playerIdForKing(king) {
  return king.originX < 0 ? "P1" : "P2";
}

export function tryRecordRoundWin() {
  if (roundEndInProgress || gameState.matchOver) return;

  const knockedKing = checkKingKnockout();
  if (!knockedKing) return;

  roundEndInProgress = true;
  const loserId = playerIdForKing(knockedKing);
  const winnerId = loserId === "P1" ? "P2" : "P1";

  gameState.scores[winnerId] = (gameState.scores[winnerId] ?? 0) + 1;

  const roundsToWin = BARRAGE_CONFIG.roundsToWin ?? 3;
  const isMatchWon = gameState.scores[winnerId] >= roundsToWin;

  broadcast({
    type: "roundEnded",
    winner: winnerId,
    loser: loserId,
    roundNumber: gameState.roundNumber,
    scores: gameState.scores,
  });

  const postSimMs = BARRAGE_CONFIG.postWinSimulationMs ?? 5000;

  if (isMatchWon) {
    setTimeout(() => {
      gameState.paused = true;
      gameState.matchOver = true;
      roundEndInProgress = false;
      broadcast({
        type: "matchEnded",
        winner: winnerId,
        scores: gameState.scores,
      });
    }, postSimMs);
    return;
  }

  const resetDelayMs = BARRAGE_CONFIG.roundEndDelayMs ?? 5000;

  setTimeout(() => {
    gameState.paused = true;
  }, postSimMs);

  setTimeout(async () => {
    gameState.roundNumber += 1;
    const level = nextLevel(gameState.currentLevel?.id);
    await reloadLevel(level);
    gameState.paused = false;
    roundEndInProgress = false;
    broadcast({
      type: "roundStarted",
      roundNumber: gameState.roundNumber,
      scores: gameState.scores,
      level: level.url,
    });
  }, resetDelayMs);
}

export async function resetMatch() {
  const level = firstLevel();
  await reloadLevel(level);
  gameState.roundNumber = 1;
  gameState.scores = {};
  gameState.paused = false;
  gameState.matchOver = false;
  roundEndInProgress = false;
  broadcast({
    type: "matchReset",
    roundNumber: gameState.roundNumber,
    scores: gameState.scores,
    level: level.url,
  });
}
```

- [ ] **Step 5: Create `server/game/drag.js`**

Drag mechanics extracted from the old `input.js`. This is the **new decomposition** — drag handling in its own module.

```javascript
import { gameObjects, dragState } from "./state.js";
import {
  isTrebuchetName,
  isMissileName,
  isKingName,
  constrainWorldBounds,
  constrainedPointForObject,
  normalReleaseVelocityMax,
  releaseVelocityForObject,
} from "./entities.js";
import { clampVector } from "../math.js";
import {
  syncPhysicsBodyFromObject,
  setPhysicsBodyTrigger,
  returnDraggedObjectUpright,
} from "./physics.js";
import { maybeLoadMissile } from "./trebuchet.js";

function velocityFromDragState(object, point) {
  const previous = dragState.get(object.id);
  if (!previous?.lastPoint || !previous.lastTime) return { x: 0, y: 0, z: 0 };

  const dt = Math.max(0.001, (Date.now() - previous.lastTime) / 1000);
  return clampVector({
    x: (Number(point.x) - Number(previous.lastPoint.x)) / dt,
    y: (Number(point.y ?? object.y) - Number(previous.lastPoint.y ?? object.y)) / dt,
    z: (Number(point.z) - Number(previous.lastPoint.z)) / dt,
  }, normalReleaseVelocityMax());
}

function usableReleaseVelocity(object, message) {
  const clientVelocity = releaseVelocityForObject(object, message.velocity);
  const clientSpeed = Math.hypot(clientVelocity.x, clientVelocity.y, clientVelocity.z);

  if (clientSpeed > 0.1) {
    return clientVelocity;
  }

  return releaseVelocityForObject(object, velocityFromDragState(object, message.point));
}

export function handleDragStart(client, message) {
  const object = gameObjects.get(message.entityId);
  if (!object || !message.point) return;
  if (!object.dynamic) return;
  if (object.loadedInto) return;
  if (isKingName(object.id)) return;

  if (!isTrebuchetName(object.id)) {
    if (client.id === 1 && object.x > 2) return;
    if (client.id === 2 && object.x < -2) return;
  }

  object.draggedBy = client.id;
  if (isMissileName(object.id)) setPhysicsBodyTrigger(object, true);
  object.vx = 0;
  object.vy = 0;
  object.vz = 0;
  returnDraggedObjectUpright(object);
  dragState.set(object.id, { lastTime: Date.now(), lastPoint: message.point });
}

export function handleDragMove(client, message) {
  const object = gameObjects.get(message.entityId);
  if (!object || !message.point) return;
  if (object.draggedBy !== client.id) return;

  const now = Date.now();
  const previous = dragState.get(object.id);
  const dt = Math.max(0.001, (now - (previous?.lastTime ?? now)) / 1000);
  const next = constrainedPointForObject(object, message.point, client.id);
  const nextX = next.x;
  const nextY = next.y;
  const nextZ = next.z;

  object.dragVx = (nextX - object.x) / dt;
  object.dragVy = (nextY - object.y) / dt;
  object.dragVz = (nextZ - object.z) / dt;
  object.x = nextX;
  object.y = nextY;
  object.z = nextZ;
  constrainWorldBounds(object);
  returnDraggedObjectUpright(object);
  syncPhysicsBodyFromObject(object, { x: 0, y: 0, z: 0 });
  object.vx = 0;
  object.vy = 0;
  object.vz = 0;
  dragState.set(object.id, { lastTime: now, lastPoint: message.point });
}

export function handleDragEnd(client, message) {
  const object = gameObjects.get(message.entityId);
  if (!object || !message.point) return;
  if (object.draggedBy !== client.id) return;

  const next = constrainedPointForObject(object, message.point, client.id);
  const releaseVelocity = usableReleaseVelocity(object, message);
  object.x = next.x;
  object.y = next.y;
  object.z = next.z;
  constrainWorldBounds(object);
  returnDraggedObjectUpright(object);
  if (!maybeLoadMissile(object)) {
    if (isMissileName(object.id)) setPhysicsBodyTrigger(object, false);
    object.vx = releaseVelocity.x;
    object.vy = releaseVelocity.y;
    object.vz = releaseVelocity.z;
    syncPhysicsBodyFromObject(object, releaseVelocity);
  } else {
    setPhysicsBodyTrigger(object, true);
    syncPhysicsBodyFromObject(object, { x: 0, y: 0, z: 0 });
  }
  object.dragVx = 0;
  object.dragVy = 0;
  object.dragVz = 0;
  object.draggedBy = null;
  dragState.delete(object.id);
}
```

- [ ] **Step 6: Create `server/game/input.js`**

Thin dispatcher. Drag delegated to `drag.js`. Aim handlers inline (they're short validation + delegation).

```javascript
import { gameObjects, gameState } from "./state.js";
import { resetMatch, resetGameState } from "./rules.js";
import {
  restArmAngleForTrebuchet,
  ARM_STATE_AIMING,
  ARM_STATE_RELEASING,
} from "./entities.js";
import { handleDragStart, handleDragMove, handleDragEnd } from "./drag.js";
import { updateTrebuchetAim, beginTrebuchetRelease } from "./trebuchet.js";
import { broadcast } from "../net/broadcast.js";

export function applyInput(client, message) {
  if (message.type !== "input") return;

  if (message.action === "reset") {
    if (gameState.matchOver) {
      resetMatch();
    } else {
      resetGameState();
      broadcast({
        type: "event",
        tick: 0,
        events: [{ kind: "reset", playerId: client.playerId }],
      });
    }
    return;
  }

  if (gameState.matchOver) return;

  if (message.action === "dragStart") return handleDragStart(client, message);
  if (message.action === "dragMove") return handleDragMove(client, message);
  if (message.action === "dragEnd") return handleDragEnd(client, message);

  if (message.action === "aimStart") {
    const missile = gameObjects.get(message.entityId);
    if (!missile || !message.point || !missile.loadedInto) return;

    const trebuchet = gameObjects.get(missile.loadedInto);
    if (!trebuchet || !trebuchet.loaded || trebuchet.fireState === ARM_STATE_RELEASING) return;

    trebuchet.fireState = ARM_STATE_AIMING;
    trebuchet.aimedBy = client.id;
    trebuchet.aimStart = {
      x: Number(message.point.x),
      y: Number(message.point.y ?? missile.y),
      z: Number(message.point.z),
    };
    trebuchet.aimCurrent = trebuchet.aimStart;
    trebuchet.pendingShot = null;
    trebuchet.releaseElapsedMs = 0;
    trebuchet.armAngle = restArmAngleForTrebuchet();
  }

  if (message.action === "aimMove") {
    const missile = gameObjects.get(message.entityId);
    if (!missile || !message.point || !missile.loadedInto) return;

    const trebuchet = gameObjects.get(missile.loadedInto);
    if (!trebuchet || trebuchet.aimedBy !== client.id || trebuchet.fireState !== ARM_STATE_AIMING) return;

    updateTrebuchetAim(trebuchet, message.point);
  }

  if (message.action === "aimRelease") {
    const missile = gameObjects.get(message.entityId);
    if (!missile || !message.point || !missile.loadedInto) return;

    const trebuchet = gameObjects.get(missile.loadedInto);
    if (!trebuchet || trebuchet.aimedBy !== client.id || trebuchet.fireState !== ARM_STATE_AIMING) return;

    updateTrebuchetAim(trebuchet, message.point);
    beginTrebuchetRelease(trebuchet);
  }

  if (message.action === "fire") {
    broadcast({
      type: "event",
      tick: 0,
      events: [{
        kind: "fire",
        playerId: client.playerId,
        start: message.start,
        end: message.end,
      }],
    });
  }
}
```

- [ ] **Step 7: Create `server/game/trebuchet.js`**

All trebuchet mechanics + `updateTrebuchetFireState` moved from `simulation.js`.

```javascript
import { gameObjects, loadTargets } from "./state.js";
import { BARRAGE_CONFIG } from "../../public/config.js";
import {
  isTrebuchetName,
  isMissileName,
  sideSignForTrebuchet,
  restArmAngleForTrebuchet,
  releaseVelocityForObject,
  trebuchetFireVelocityMax,
  ARM_STATE_IDLE,
  ARM_STATE_RELEASING,
  ARM_STATE_RETURNING,
} from "./entities.js";
import { clamp, lerp } from "../math.js";
import { setPhysicsBodyTrigger, syncPhysicsBodyFromObject } from "./physics.js";

export function updateTrebuchetFireState(dt) {
  for (const trebuchet of gameObjects.values()) {
    if (!isTrebuchetName(trebuchet.id)) continue;

    if (trebuchet.fireState === ARM_STATE_RETURNING) {
      const durationMs = Math.max(1, BARRAGE_CONFIG.fireReturnAnimationMs ?? 220);
      trebuchet.releaseElapsedMs = (trebuchet.releaseElapsedMs ?? 0) + dt * 1000;
      const progress = clamp(trebuchet.releaseElapsedMs / durationMs, 0, 1);
      const startArmAngle = trebuchet.returnStartArmAngle ?? trebuchet.armAngle ?? 0;
      const restArmAngle = restArmAngleForTrebuchet();
      trebuchet.armAngle = lerp(startArmAngle, restArmAngle, progress);

      if (progress >= 1) {
        trebuchet.armAngle = restArmAngle;
        trebuchet.fireState = ARM_STATE_IDLE;
        trebuchet.returnStartArmAngle = null;
        trebuchet.releaseElapsedMs = 0;
      }

      continue;
    }

    if (trebuchet.fireState !== ARM_STATE_RELEASING) continue;

    const durationMs = Math.max(1, BARRAGE_CONFIG.fireReleaseAnimationMs ?? 180);
    trebuchet.releaseElapsedMs = (trebuchet.releaseElapsedMs ?? 0) + dt * 1000;
    const progress = clamp(trebuchet.releaseElapsedMs / durationMs, 0, 1);
    const startArmAngle = trebuchet.pendingShot?.startArmAngle ?? trebuchet.armAngle ?? 0;
    const restArmAngle = restArmAngleForTrebuchet(trebuchet);
    const previousArmAngle = trebuchet.armAngle ?? startArmAngle;
    const velocity = trebuchet.pendingShot?.velocity ?? { x: 0, y: 0, z: 0 };
    trebuchet.armAngle = lerp(startArmAngle, 0, progress);

    const shouldReleaseAtRest = !trebuchet.pendingShot?.released
      && (startArmAngle <= restArmAngle || (previousArmAngle > restArmAngle && trebuchet.armAngle <= restArmAngle));

    if (shouldReleaseAtRest) {
      releaseLoadedMissileFromTrebuchet(trebuchet, velocity, restArmAngle);
      if (trebuchet.pendingShot) {
        trebuchet.pendingShot.released = true;
      }
    }

    if (progress < 1) continue;

    if (!trebuchet.pendingShot?.released) {
      releaseLoadedMissileFromTrebuchet(trebuchet, velocity, restArmAngle);
    }

    trebuchet.fireState = ARM_STATE_RETURNING;
    trebuchet.pendingShot = null;
    trebuchet.returnStartArmAngle = trebuchet.armAngle;
    trebuchet.releaseElapsedMs = 0;
  }
}

export function loadTargetForTrebuchet(trebuchet) {
  const target = loadTargets.get(trebuchet.id) ?? loadTargets.get("default") ?? null;
  if (!target) return null;

  if (target.targetNode && target.rootNode) {
    target.rootNode.position.x = trebuchet.x;
    target.rootNode.position.y = trebuchet.y;
    target.rootNode.position.z = trebuchet.z;

    if (target.armNode && typeof trebuchet.armAngle === "number") {
      target.armNode.rotationQuaternion = null;
      target.armNode.rotation.z = (trebuchet.armAngle * Math.PI) / 180;
    }

    target.rootNode.computeWorldMatrix(true);
    target.armNode?.computeWorldMatrix(true);
    target.targetNode.computeWorldMatrix(true);

    const targetPosition = target.targetNode.getAbsolutePosition();
    const rootPosition = target.rootNode.getAbsolutePosition();

    return {
      x: trebuchet.x - (targetPosition.x - rootPosition.x),
      y: trebuchet.y + (targetPosition.y - rootPosition.y),
      z: trebuchet.z + (targetPosition.z - rootPosition.z),
    };
  }

  return {
    x: trebuchet.x + target.offsetX,
    y: trebuchet.y + target.offsetY,
    z: trebuchet.z + target.offsetZ,
  };
}

export function maybeLoadMissile(missile) {
  if (!isMissileName(missile.id)) return false;

  for (const trebuchet of gameObjects.values()) {
    if (!isTrebuchetName(trebuchet.id) || trebuchet.loaded) continue;

    const range = BARRAGE_CONFIG.missileLoadRange ?? 6;
    const target = loadTargetForTrebuchet(trebuchet);
    if (!target) continue;

    const rootDistance = Math.hypot(missile.x - trebuchet.x, missile.z - trebuchet.z);
    const targetDistance = Math.hypot(missile.x - target.x, missile.z - target.z);
    if (Math.min(rootDistance, targetDistance) > range) continue;

    missile.x = target.x;
    missile.y = target.y;
    missile.z = target.z;
    missile.vx = 0;
    missile.vy = 0;
    missile.vz = 0;
    missile.loadedInto = trebuchet.id;
    setPhysicsBodyTrigger(missile, true);
    trebuchet.loaded = true;
    trebuchet.loadedMissileId = missile.id;
    trebuchet.fireState = ARM_STATE_IDLE;
    trebuchet.armAngle = restArmAngleForTrebuchet();
    return true;
  }

  return false;
}

export function updateTrebuchetAim(trebuchet, point) {
  const start = trebuchet.aimStart;
  if (!start) return;

  const requested = {
    x: Number(point.x),
    y: Number(point.y ?? start.y),
    z: Number(point.z ?? start.z),
  };
  const pullX = requested.x - start.x;
  const pullY = requested.y - start.y;
  const pullDistance = Math.hypot(pullX, pullY);
  const maxPullDistance = BARRAGE_CONFIG.aimMaxPullDistance ?? 6;
  const clampedDistance = clamp(pullDistance, 0, maxPullDistance);
  const pullScale = pullDistance > 0.0001 ? clampedDistance / pullDistance : 0;
  const current = {
    x: start.x + pullX * pullScale,
    y: start.y + pullY * pullScale,
    z: requested.z,
  };
  trebuchet.aimCurrent = current;

  const pullRatio = clampedDistance / Math.max(0.001, maxPullDistance);
  const maxExtra = BARRAGE_CONFIG.trebuchetArmPullbackMaxDegrees
    ?? BARRAGE_CONFIG.aimArmMaxExtraDegrees
    ?? 45;
  const restAngle = Math.abs(BARRAGE_CONFIG.trebuchetArmRestRotationZDegrees ?? 15);

  trebuchet.armAngle = restAngle + pullRatio * maxExtra;
}

export function beginTrebuchetRelease(trebuchet) {
  const start = trebuchet.aimStart;
  const current = trebuchet.aimCurrent ?? start;
  if (!start || !current) return;

  const powerScale = BARRAGE_CONFIG.aimPowerScale ?? 8;
  const shotDirectionX = sideSignForTrebuchet(trebuchet.id);
  const velocity = releaseVelocityForObject({ id: "missile" }, {
    x: Math.abs(start.x - current.x) * powerScale * shotDirectionX,
    y: (start.y - current.y) * powerScale,
    z: (start.z - current.z) * powerScale,
  }, trebuchetFireVelocityMax());

  trebuchet.fireState = ARM_STATE_RELEASING;
  trebuchet.pendingShot = {
    velocity,
    released: false,
    startArmAngle: trebuchet.armAngle ?? (BARRAGE_CONFIG.trebuchetArmRestRotationZDegrees ?? 15),
  };
  trebuchet.releaseElapsedMs = 0;
}

function targetPointForTrebuchetAtArmAngle(trebuchet, armAngle) {
  const previousAngle = trebuchet.armAngle;
  trebuchet.armAngle = armAngle;
  const target = loadTargetForTrebuchet(trebuchet);
  const point = target ? { x: target.x, y: target.y, z: target.z } : null;
  trebuchet.armAngle = previousAngle;
  loadTargetForTrebuchet(trebuchet);
  return point;
}

export function releaseLoadedMissileFromTrebuchet(trebuchet, velocity, armAngle = null) {
  const missile = trebuchet.loadedMissileId ? gameObjects.get(trebuchet.loadedMissileId) : null;
  if (!missile || missile.loadedInto !== trebuchet.id) return false;

  const target = armAngle === null
    ? loadTargetForTrebuchet(trebuchet)
    : targetPointForTrebuchetAtArmAngle(trebuchet, armAngle);

  if (target) {
    missile.x = target.x;
    missile.y = target.y;
    missile.z = target.z;
  }

  missile.loadedInto = null;
  setPhysicsBodyTrigger(missile, false);
  missile.vx = velocity.x;
  missile.vy = velocity.y;
  missile.vz = velocity.z;
  syncPhysicsBodyFromObject(missile, velocity);

  trebuchet.loaded = false;
  trebuchet.loadedMissileId = null;
  trebuchet.aimedBy = null;
  trebuchet.aimStart = null;
  trebuchet.aimCurrent = null;
  return true;
}
```

- [ ] **Step 8: Create `server/game/simulation.js`**

Pure physics orchestration. Arm animation moved to `trebuchet.js`. Three clear phases: pre-constraints → step → sync.

```javascript
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { gameObjects } from "./state.js";
import {
  scene,
  physicsAggregates,
  syncPhysicsBodyFromObject,
  constrainBodyToPlane,
  returnDraggedObjectUpright,
} from "./physics.js";
import { SERVER_CONFIG, TICK_MS } from "../config.js";
import { BARRAGE_CONFIG } from "../../public/config.js";
import { isTrebuchetName } from "./entities.js";
import { babylonToProtocolRotationZ } from "../math.js";
import { updateTrebuchetFireState, loadTargetForTrebuchet } from "./trebuchet.js";

export function simulatePhysics() {
  const scaledDt = (TICK_MS / 1000) * (BARRAGE_CONFIG.physicsTimeScale ?? 1);
  updateTrebuchetFireState(scaledDt);

  for (const object of gameObjects.values()) {
    if (!object.dynamic) continue;

    if (object.loadedInto) {
      const trebuchet = gameObjects.get(object.loadedInto);
      const target = trebuchet ? loadTargetForTrebuchet(trebuchet) : null;
      if (target) {
        object.x = target.x;
        object.y = target.y;
        object.z = target.z;
      }
      object.vx = 0;
      object.vy = 0;
      object.vz = 0;
      syncPhysicsBodyFromObject(object, { x: 0, y: 0, z: 0 });
      continue;
    }

    if (object.draggedBy) {
      returnDraggedObjectUpright(object);
      syncPhysicsBodyFromObject(object, { x: 0, y: 0, z: 0 });
      continue;
    }

    if (isTrebuchetName(object.id)) {
      const aggregate = physicsAggregates.get(object.id);
      if (!aggregate) continue;
      const velocity = aggregate.body.getLinearVelocity();
      velocity.y = 0;
      velocity.z = 0;
      aggregate.body.setLinearVelocity(velocity);
    }
  }

  scene.getPhysicsEngine()?._step(scaledDt);

  for (const object of gameObjects.values()) {
    if (!object.dynamic) continue;
    if (object.draggedBy || object.loadedInto) continue;

    const aggregate = physicsAggregates.get(object.id);
    if (!aggregate) continue;

    constrainBodyToPlane(object);
    const node = aggregate.transformNode;
    const linearVelocity = aggregate.body.getLinearVelocity();
    const euler = node.rotationQuaternion?.toEulerAngles() ?? Vector3.Zero();

    object.x = node.position.x;
    object.y = node.position.y;
    object.z = object.originZ;
    object.rot = isTrebuchetName(object.id) ? 0 : babylonToProtocolRotationZ(euler.z);
    object.vx = linearVelocity.x;
    object.vy = linearVelocity.y;
    object.vz = 0;

    const floorY = SERVER_CONFIG.groundY + object.halfY - (object.offsetY ?? 0);
    if (object.y < floorY) {
      object.y = floorY;
      if (object.vy < 0) object.vy = 0;
      node.position.y = floorY;
      aggregate.body.setLinearVelocity(new Vector3(object.vx, 0, 0));
    }
  }
}
```

- [ ] **Step 9: Create `server/game/registration.js`**

Mesh scanning, game object creation, and bounds calculation. All the "GLB mesh tree → game objects" logic in one place.

```javascript
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { scene } from "./physics.js";
import { gameObjects, loadTargets } from "./state.js";
import { SERVER_CONFIG } from "../config.js";
import {
  isDynamicName,
  isTrebuchetName,
  isMissileName,
  isKingName,
  restArmAngleForTrebuchet,
  ARM_STATE_IDLE,
} from "./entities.js";
import { createPhysicsBodies } from "./physics.js";

function childRole(name) {
  if (name.includes("ColVis")) return "ColVis";
  if (name.includes("Visual") || name.includes("Vis")) return "Vis";
  if (name.includes("Collider") || name.includes("Col")) return "Col";
  return null;
}

function descendantsOf(transform) {
  const descendants = [];
  const stack = [...transform.getChildren()];
  while (stack.length > 0) {
    const child = stack.pop();
    descendants.push(child);
    if (typeof child.getChildren === "function") {
      stack.push(...child.getChildren());
    }
  }
  return descendants;
}

function isTrebuchetArmName(name) {
  const lowerName = name.toLowerCase();
  return lowerName.includes("trebuche") && lowerName.includes("arm");
}

export function isTrebuchetArmRoot(transform) {
  const lowerName = transform.name.toLowerCase();
  return isTrebuchetArmName(transform.name)
    && transform.parent
    && isTrebuchetName(transform.parent.name)
    && !lowerName.includes("visual")
    && !lowerName.includes("collider")
    && !lowerName.includes("col")
    && descendantsOf(transform).some((child) => child.name.toLowerCase().includes("missile-load-target"));
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

function isNestedTrebuchetArmDescendant(root, node) {
  let current = node.parent;
  while (current && current !== root) {
    if (isTrebuchetArmRoot(current)) return true;
    current = current.parent;
  }
  return false;
}

function colliderBoundsFor(transform) {
  try {
    const colliderNodes = descendantsOf(transform).filter((child) => {
      const role = childRole(child.name);
      return (role === "Col" || role === "ColVis")
        && !isNestedTrebuchetArmDescendant(transform, child);
    });
    const bounds = boundsForNodes(colliderNodes.length > 0 ? colliderNodes : [transform]);
    const absolutePosition = transform.getAbsolutePosition();
    const centerX = (bounds.min.x + bounds.max.x) / 2;
    const centerY = (bounds.min.y + bounds.max.y) / 2;
    const centerZ = (bounds.min.z + bounds.max.z) / 2;
    return {
      offsetX: centerX - absolutePosition.x,
      offsetY: centerY - absolutePosition.y,
      offsetZ: centerZ - absolutePosition.z,
      halfX: Math.max(0.05, (bounds.max.x - bounds.min.x) / 2),
      halfY: Math.max(0.05, (bounds.max.y - bounds.min.y) / 2),
      halfZ: Math.max(0.05, (bounds.max.z - bounds.min.z) / 2),
    };
  } catch {
    return { offsetX: 0, offsetY: 0, offsetZ: 0, halfX: 0.5, halfY: 0.5, halfZ: 0.5 };
  }
}

function findGameplayRootAncestor(node) {
  let current = node.parent;
  let candidate = null;
  while (current) {
    if (isTrebuchetName(current.name)) candidate = current;
    if (current.parent?.name === "__root__") {
      return isTrebuchetName(current.name) ? current : candidate;
    }
    current = current.parent;
  }
  return candidate;
}

function findTrebuchetArmAncestor(node) {
  let current = node.parent;
  while (current) {
    if (isTrebuchetArmRoot(current)) return current;
    current = current.parent;
  }
  return null;
}

export function registerMeshRoots() {
  loadTargets.clear();

  for (const transform of scene.transformNodes) {
    if (transform.name.toLowerCase().includes("missile-load-target")) {
      const parentTrebuchet = findGameplayRootAncestor(transform);
      const position = transform.getAbsolutePosition();
      const parentAbsolute = parentTrebuchet?.getAbsolutePosition();
      const offset = parentTrebuchet && parentAbsolute
        ? {
          x: -(position.x - parentAbsolute.x),
          y: position.y - parentAbsolute.y,
          z: position.z - parentAbsolute.z,
        }
        : null;
      const target = {
        ...(offset
          ? { offsetX: offset.x, offsetY: offset.y, offsetZ: offset.z }
          : { offsetX: transform.position.x, offsetY: transform.position.y, offsetZ: transform.position.z }),
        targetNode: transform,
        rootNode: parentTrebuchet ?? null,
        armNode: findTrebuchetArmAncestor(transform),
      };
      loadTargets.set(parentTrebuchet?.name ?? "default", target);
      loadTargets.set("default", target);
    }
  }

  for (const transform of scene.transformNodes) {
    if (transform.parent && transform.parent.name !== "__root__") continue;
    const hasGameplayChild = descendantsOf(transform).some((child) => childRole(child.name));
    if (!hasGameplayChild) continue;

    const position = transform.position;
    const dynamic = isDynamicName(transform.name);
    const bounds = colliderBoundsFor(transform);
    gameObjects.set(transform.name, {
      id: transform.name,
      x: position.x,
      y: position.y,
      z: position.z,
      originX: position.x,
      originY: position.y,
      originZ: position.z,
      rot: 0,
      angularVelocity: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      dragVx: 0,
      dragVy: 0,
      dragVz: 0,
      dynamic,
      draggedBy: null,
      offsetX: bounds.offsetX,
      offsetY: bounds.offsetY,
      offsetZ: bounds.offsetZ,
      halfX: bounds.halfX,
      halfY: bounds.halfY,
      halfZ: bounds.halfZ,
      halfHeight: bounds.halfY,
      mass: dynamic ? SERVER_CONFIG.dynamicMass : 0,
      friction: dynamic ? SERVER_CONFIG.dynamicFriction : 1,
      restitution: dynamic ? SERVER_CONFIG.dynamicRestitution : 0,
      ...(isTrebuchetName(transform.name) ? {
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
      ...(isMissileName(transform.name) ? { loadedInto: null } : {}),
      ...(isKingName(transform.name) ? { hits: 0, maxHits: 3 } : {}),
    });
  }

  createPhysicsBodies();
}
```

- [ ] **Step 10: Create `server/game/level.js`**

GLB loading and scene management only. Mesh registration delegated to `registration.js`.

```javascript
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import xhr2 from "xhr2";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader.js";
import "@babylonjs/loaders/glTF/index.js";
import { scene, physicsAggregates } from "./physics.js";
import { gameObjects, loadTargets, gameState } from "./state.js";
import { PORT } from "../config.js";
import { BARRAGE_CONFIG } from "../../public/config.js";
import { isTrebuchetArmRoot, registerMeshRoots } from "./registration.js";

const { XMLHttpRequest } = xhr2;
globalThis.XMLHttpRequest = XMLHttpRequest;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const publicDir = path.join(__dirname, "../../public");
const assetsDir = path.join(publicDir, "assets");

function applyTrebuchetArmRestPose() {
  for (const transform of scene.transformNodes) {
    if (!isTrebuchetArmRoot(transform)) continue;

    const degrees = BARRAGE_CONFIG.trebuchetArmRestRotationZDegrees ?? 15;
    const radians = (degrees * Math.PI) / 180;

    transform.rotationQuaternion = null;
    transform.rotation.z = radians;
    transform.computeWorldMatrix(true);
  }
}

function clearScene() {
  for (const [, aggregate] of physicsAggregates) {
    aggregate.dispose();
  }
  physicsAggregates.clear();
  gameObjects.clear();
  loadTargets.clear();

  const rootNodes = scene.rootNodes.filter((n) => n.name === "__root__");
  for (const root of rootNodes) {
    root.dispose(false, true);
  }
}

export async function loadLevelIfPresent(level) {
  const file = level?.file ?? "level1.glb";
  const levelPath = path.join(assetsDir, file);

  try {
    await fs.access(levelPath);
  } catch {
    console.log(`No GLB found at public/assets/${file}; starting with an empty scene.`);
    return;
  }

  await SceneLoader.AppendAsync(`http://localhost:${PORT}/assets/`, file, scene);
  applyTrebuchetArmRestPose();
  registerMeshRoots();
  console.log(`Loaded ${file} with ${gameObjects.size} gameplay objects.`);
  for (const object of gameObjects.values()) {
    console.log(
      `Object ${object.id}: dynamic=${object.dynamic} pos=(${object.x.toFixed(2)}, ${object.y.toFixed(2)}, ${object.z.toFixed(2)}) half=(${object.halfX.toFixed(2)}, ${object.halfY.toFixed(2)}, ${object.halfZ.toFixed(2)}) offset=(${object.offsetX.toFixed(2)}, ${object.offsetY.toFixed(2)}, ${object.offsetZ.toFixed(2)})`,
    );
  }
}

export async function reloadLevel(level) {
  clearScene();
  gameState.currentLevel = level;
  await loadLevelIfPresent(level);
}
```

- [ ] **Step 11: Create `server/game/levelCatalog.js`**

```javascript
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.join(__dirname, "../../public/assets");

let levels = [];

export async function discoverLevels() {
  const files = await fs.readdir(assetsDir);
  levels = files
    .filter((f) => /^level\d+\.glb$/i.test(f))
    .sort((a, b) => {
      const numA = parseInt(a.match(/\d+/)[0], 10);
      const numB = parseInt(b.match(/\d+/)[0], 10);
      return numA - numB;
    })
    .map((file) => ({
      id: file.replace(".glb", ""),
      file,
      url: `/assets/${file}`,
    }));

  if (levels.length === 0) {
    levels = [{ id: "level1", file: "level1.glb", url: "/assets/level1.glb" }];
  }

  return levels;
}

export function firstLevel() {
  return levels[0];
}

export function nextLevel(currentLevelId) {
  const index = levels.findIndex((l) => l.id === currentLevelId);
  if (index < 0) return firstLevel();
  return levels[(index + 1) % levels.length];
}
```

- [ ] **Step 12: Verify and commit**

```bash
node server/index.js
# Server should start — old files still exist, bridges forward, new files coexist.
git add server/game/ server/net/
git commit -m "refactor: create decomposed game and network modules"
```

---

### Task 4: Rewrite index.js, delete old files

Switch `index.js` to import from new locations. Delete all old files and bridges.

**Files:**
- Rewrite: `server/index.js`
- Delete: `server/state.js`, `server/physics.js`, `server/utils.js`, `server/network.js`, `server/gameManager.js`, `server/simulation.js`, `server/input.js`, `server/trebuchet.js`, `server/level.js`, `server/levelCatalog.js`

- [ ] **Step 1: Rewrite `server/index.js`**

Pure server bootstrap. No game logic, no WebSocket handling, no tick loop.

```javascript
import express from "express";
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PORT } from "./config.js";
import { clients, gameState } from "./game/state.js";
import { enableHavokPhysics } from "./game/physics.js";
import { loadLevelIfPresent } from "./game/level.js";
import { discoverLevels, firstLevel } from "./game/levelCatalog.js";
import { setupWebSocket } from "./net/connections.js";
import { startGameLoop, stopGameLoop } from "./game/loop.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const publicDir = path.join(__dirname, "../public");

const app = express();
app.use((_request, response, next) => {
  response.setHeader("Cache-Control", "no-store");
  next();
});

const httpServer = http.createServer(app);
const wss = setupWebSocket(httpServer);

let restartInProgress = false;

function isLocalRequest(request) {
  const remoteAddress = request.ip || request.socket.remoteAddress || "";
  return remoteAddress === "::1"
    || remoteAddress === "127.0.0.1"
    || remoteAddress === "::ffff:127.0.0.1";
}

function closeSocket(socket) {
  try {
    socket.terminate();
  } catch {
    // Ignore restart close races.
  }
}

function closeWithTimeout(closeFn, timeoutMs = 1000) {
  return new Promise((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const timer = setTimeout(finish, timeoutMs);
    closeFn(() => {
      clearTimeout(timer);
      finish();
    });
  });
}

async function restartServerProcess() {
  if (restartInProgress) return;
  restartInProgress = true;
  console.log("Restart requested from local browser.");

  stopGameLoop();

  for (const client of clients.values()) {
    closeSocket(client.socket);
  }

  await closeWithTimeout((done) => wss.close(done));
  await closeWithTimeout((done) => httpServer.close(done));

  const child = spawn(process.execPath, [path.join(__dirname, "index.js")], {
    cwd: __dirname,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  process.exit(0);
}

app.post("/admin/restart", (request, response) => {
  if (!isLocalRequest(request)) {
    response.status(403).json({ ok: false, error: "local-only" });
    return;
  }

  if (restartInProgress) {
    response.status(409).json({ ok: false, error: "restart-in-progress" });
    return;
  }

  response.json({ ok: true, restarting: true });
  response.on("finish", () => {
    restartServerProcess().catch((error) => {
      console.error("Failed to restart server process.", error);
      process.exit(1);
    });
  });
});

app.use(express.static(publicDir));

await new Promise((resolve) => {
  httpServer.listen(PORT, () => {
    console.log(`Barrage server running at http://localhost:${PORT}`);
    resolve();
  });
});

await enableHavokPhysics();
await discoverLevels();
gameState.currentLevel = firstLevel();
await loadLevelIfPresent(gameState.currentLevel);

startGameLoop();
```

- [ ] **Step 2: Delete old files**

```bash
rm server/state.js server/physics.js server/utils.js server/network.js server/gameManager.js server/simulation.js server/input.js server/trebuchet.js server/level.js server/levelCatalog.js
```

- [ ] **Step 3: Verify server starts**

```bash
node server/index.js
```

Expected: Server starts on configured port, loads level, prints gameplay objects. No import errors.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: complete server reorganization with decomposed modules"
```
