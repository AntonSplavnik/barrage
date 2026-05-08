import express from "express";
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import xhr2 from "xhr2";
import { WebSocketServer } from "ws";
import HavokPhysics from "@babylonjs/havok";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera.js";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin.js";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate.js";
import { PhysicsPrestepType, PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin.js";
import "@babylonjs/core/Physics/v2/physicsEngineComponent.js";
import { Scene } from "@babylonjs/core/scene.js";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader.js";
import "@babylonjs/loaders/glTF/index.js";
import { SERVER_CONFIG } from "./config/server.js";
import { BARRAGE_CONFIG } from "./public/config.js";
import { firstLevel, nextLevel } from "./server/levelCatalog.js";
import { RoomManager } from "./server/roomManager.js";
import { playerSide, canGrab, isInPlayerZone, zoneLimitX, checkKingKnockout } from "./server/gameManager.js";

const { XMLHttpRequest } = xhr2;
globalThis.XMLHttpRequest = XMLHttpRequest;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const TICK_RATE = 60;
const TICK_MS = 1000 / TICK_RATE;
const publicDir = path.join(__dirname, "public");
const assetsDir = path.join(publicDir, "assets");

const app = express();
app.use((_request, response, next) => {
  response.setHeader("Cache-Control", "no-store");
  next();
});

const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer });

const clients = new Map();
let nextClientId = 1;
let simulationInterval = null;
let restartInProgress = false;
let activeRoom = null;
let engine = null;
let scene = null;
let tick = 0;
let gameObjects = null;
let dragState = null;
let fragmentTemplateData = null;
let loadTargets = null;
let physicsAggregates = null;
let havokInterfacePromise = null;

const ARM_STATE_IDLE = "idle";
const ARM_STATE_AIMING = "aiming";
const ARM_STATE_RELEASING = "releasing";
const ARM_STATE_RETURNING = "returning";

function createRoomRuntime(room) {
  room.engine?.dispose?.();
  room.scene?.dispose?.();

  const roomEngine = new NullEngine({
    renderHeight: 1,
    renderWidth: 1,
    textureSize: 1,
    deterministicLockstep: false,
  });
  const roomScene = new Scene(roomEngine);
  roomScene.activeCamera = new FreeCamera(`HeadlessCamera-${room.id}`, new Vector3(0, 10, -10), roomScene);

  room.engine = roomEngine;
  room.scene = roomScene;
  room.tick = 0;
  room.gameObjects = new Map();
  room.dragState = new Map();
  room.loadTargets = new Map();
  room.physicsAggregates = new Map();
}

function createRoomState({ id, index, playerIds }) {
  const room = {
    id,
    index,
    playerIds,
    clients: new Map(),
    level: firstLevel(),
    roundNumber: 1,
    scores: Object.fromEntries(playerIds.map((playerId) => [playerId, 0])),
    roundWinner: null,
    paused: false,
  };
  createRoomRuntime(room);
  return room;
}

function resetRoomProgress(room) {
  room.level = firstLevel();
  room.roundNumber = 1;
  room.roundWinner = null;
  room.paused = false;
  room.scores = Object.fromEntries(room.playerIds.map((playerId) => [playerId, 0]));
}

function bindRoom(room) {
  activeRoom = room;
  engine = room.engine;
  scene = room.scene;
  tick = room.tick;
  gameObjects = room.gameObjects;
  dragState = room.dragState;
  loadTargets = room.loadTargets;
  physicsAggregates = room.physicsAggregates;
}

function saveActiveRoomTick() {
  if (activeRoom) {
    activeRoom.tick = tick;
  }
}

const roomManager = new RoomManager({
  async createRoom(roomInfo) {
    const room = createRoomState(roomInfo);
    bindRoom(room);
    await enableHavokPhysics();
    await loadLevelIfPresent();
    await loadFragmentTemplates();
    saveActiveRoomTick();
    return room;
  },
});

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

  if (simulationInterval) {
    clearInterval(simulationInterval);
    simulationInterval = null;
  }

  for (const client of clients.values()) {
    closeSocket(client.socket);
  }

  await closeWithTimeout((done) => wss.close(done));
  await closeWithTimeout((done) => httpServer.close(done));

  const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
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

function toWireObject(object) {
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

function childRole(name) {
  if (name.includes("ColVis")) return "ColVis";
  if (name.includes("Visual") || name.includes("Vis")) return "Vis";
  if (name.includes("Collider") || name.includes("Col")) return "Col";
  return null;
}

function isDynamicName(name) {
  const lowerName = name.toLowerCase();
  return lowerName.includes("block")
    || lowerName.includes("trebuche")
    || lowerName.includes("missile")
    || lowerName.includes("king");
}

function isTrebuchetName(name) {
  return name.toLowerCase().includes("trebuche");
}

function isTrebuchetArmName(name) {
  const lowerName = name.toLowerCase();
  return lowerName.includes("trebuche") && lowerName.includes("arm");
}

function isTrebuchetArmRoot(transform) {
  const lowerName = transform.name.toLowerCase();
  return isTrebuchetArmName(transform.name)
    && transform.parent
    && isTrebuchetName(transform.parent.name)
    && !lowerName.includes("visual")
    && !lowerName.includes("collider")
    && !lowerName.includes("col")
    && descendantsOf(transform).some((child) => child.name.toLowerCase().includes("missile-load-target"));
}

function isMissileName(name) {
  return name.toLowerCase().includes("missile");
}

function isKingName(name) {
  return name.toLowerCase().includes("king");
}

function isBlockName(name) {
  const lowerName = name.toLowerCase();
  return lowerName.includes("block") && !lowerName.includes("frag");
}

function isLeftSideTrebuchetName(name) {
  const lowerName = name.toLowerCase();
  return lowerName.includes("p1") || lowerName.includes("left") || lowerName.includes("1");
}

function sideSignForTrebuchet(name) {
  return isLeftSideTrebuchetName(name) ? 1 : -1;
}

function restArmAngleForTrebuchet(trebuchet) {
  return BARRAGE_CONFIG.trebuchetArmRestRotationZDegrees ?? 15;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clampVector(vector, maxMagnitude) {
  const magnitude = Math.hypot(vector.x, vector.y, vector.z);
  if (magnitude <= maxMagnitude || magnitude === 0) return vector;

  const scale = maxMagnitude / magnitude;
  return {
    x: vector.x * scale,
    y: vector.y * scale,
    z: vector.z * scale,
  };
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function shortestAngleDeltaDegrees(from, to) {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

function lerpAngleDegrees(from, to, t) {
  return from + shortestAngleDeltaDegrees(from, to) * t;
}

function protocolToBabylonRotation(rotDegrees) {
  return -(rotDegrees * Math.PI) / 180;
}

function babylonToProtocolRotationZ(radians) {
  return -(radians * 180) / Math.PI;
}

function rotationQuaternionForObject(object) {
  return Quaternion.FromEulerAngles(0, 0, protocolToBabylonRotation(object.rot ?? 0));
}

function velocityComponent(object, axis) {
  if (axis === "x") return object.vx;
  if (axis === "y") return object.vy;
  return object.vz;
}

function setVelocityComponent(object, axis, value) {
  if (axis === "x") object.vx = value;
  if (axis === "y") object.vy = value;
  if (axis === "z") object.vz = value;
}

function clampAngularVelocity(value) {
  const max = BARRAGE_CONFIG.maxAngularVelocity ?? 540;
  return clamp(value, -max, max);
}

function normalReleaseVelocityMax() {
  return BARRAGE_CONFIG.normalReleaseVelocityMax
    ?? BARRAGE_CONFIG.releaseVelocityMax
    ?? SERVER_CONFIG.releaseVelocityMax;
}

function trebuchetFireVelocityMax() {
  return BARRAGE_CONFIG.trebuchetFireVelocityMax
    ?? SERVER_CONFIG.releaseVelocityMax;
}

function releaseVelocityForObject(object, velocity = {}, maxVelocity = normalReleaseVelocityMax()) {
  const clamped = clampVector({
    x: Number(velocity.x ?? 0),
    y: Number(velocity.y ?? 0),
    z: Number(velocity.z ?? 0),
  }, maxVelocity);

  if (isTrebuchetName(object.id)) {
    return {
      x: clamped.x,
      y: 0,
      z: 0,
    };
  }

  return clamped;
}

function shouldReturnUprightWhileDragged(object) {
  return object.dynamic
    && !isTrebuchetName(object.id)
    && !isMissileName(object.id)
    && !object.loadedInto;
}

function returnDraggedObjectUpright(object) {
  if (!shouldReturnUprightWhileDragged(object)) return;

  const amount = clamp(BARRAGE_CONFIG.dragUprightLerp ?? 0.25, 0, 1);
  object.rot = lerpAngleDegrees(object.rot ?? 0, 0, amount);

  const aggregate = physicsAggregates.get(object.id);
  if (aggregate) {
    aggregate.body.setAngularVelocity(Vector3.Zero());
  }
}

function constrainWorldBounds(object) {
  object.x = clamp(object.x, SERVER_CONFIG.worldMinX, SERVER_CONFIG.worldMaxX);
  object.z = clamp(object.z, SERVER_CONFIG.worldMinZ, SERVER_CONFIG.worldMaxZ);

  if (object.x === SERVER_CONFIG.worldMinX && object.vx < 0) object.vx = 0;
  if (object.x === SERVER_CONFIG.worldMaxX && object.vx > 0) object.vx = 0;
  if (object.z === SERVER_CONFIG.worldMinZ && object.vz < 0) object.vz = 0;
  if (object.z === SERVER_CONFIG.worldMaxZ && object.vz > 0) object.vz = 0;
}

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

function constrainedPointForObject(object, point) {
  if (!isTrebuchetName(object.id)) {
    return {
      x: Number(point.x),
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

function distance3(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function loadTargetForTrebuchet(trebuchet) {
  const target = loadTargets.get(trebuchet.id) ?? loadTargets.get("default") ?? null;
  if (!target) return null;

  if (target.targetNode && target.rootNode) {
    target.rootNode.position.x = trebuchet.x;
    target.rootNode.position.y = trebuchet.y;
    target.rootNode.position.z = trebuchet.z;

    if (target.armNode && typeof trebuchet.armAngle === "number") {
      target.armNode.rotationQuaternion = null;
      target.armNode.rotation.z = sideSignForTrebuchet(trebuchet.id) * (trebuchet.armAngle * Math.PI) / 180;
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

function maybeLoadMissile(missile) {
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
    trebuchet.armAngle = restArmAngleForTrebuchet(trebuchet);
    return true;
  }

  return false;
}

function estimateHalfHeight(transform) {
  return colliderBoundsFor(transform).halfY;
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
    return {
      offsetX: 0,
      offsetY: 0,
      offsetZ: 0,
      halfX: 0.5,
      halfY: 0.5,
      halfZ: 0.5,
    };
  }
}

function boundsForNodes(nodes) {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

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

  if (!Number.isFinite(minX)) {
    throw new Error("No bounds");
  }

  return {
    min: new Vector3(minX, minY, minZ),
    max: new Vector3(maxX, maxY, maxZ),
  };
}

function aabbFor(object) {
  const centerX = object.x + object.offsetX;
  const centerY = object.y + object.offsetY;
  const centerZ = object.z + object.offsetZ;

  return {
    minX: centerX - object.halfX,
    maxX: centerX + object.halfX,
    minY: centerY - object.halfY,
    maxY: centerY + object.halfY,
    minZ: centerZ - object.halfZ,
    maxZ: centerZ + object.halfZ,
  };
}

function overlapOnAxis(aMin, aMax, bMin, bMax) {
  return Math.min(aMax, bMax) - Math.max(aMin, bMin);
}

function isGroundName(name) {
  return name.toLowerCase().includes("ground");
}

function isLeftSideKingName(name) {
  const lowerName = name.toLowerCase();
  return lowerName.includes("kingl")
    || lowerName.includes("left")
    || lowerName.includes("p1")
    || lowerName.endsWith("l");
}

function playerIdForKing(king) {
  return isLeftSideKingName(king.id) ? activeRoom.playerIds[0] : activeRoom.playerIds[1];
}

function opponentPlayerId(playerId) {
  return activeRoom.playerIds.find((candidate) => candidate !== playerId) ?? null;
}

function broadcast(message) {
  if (!activeRoom) return;

  const payload = JSON.stringify(message);
  for (const client of activeRoom.clients.values()) {
    if (client.socket.readyState === client.socket.OPEN) {
      client.socket.send(payload);
    }
  }
}

function sendState() {
  const message = {
    type: "state",
    roomId: activeRoom.id,
    tick,
    serverTime: Date.now(),
    level: activeRoom.level.url,
    roundNumber: activeRoom.roundNumber,
    scores: activeRoom.scores,
    objects: [...gameObjects.values()].map(toWireObject),
  };
  broadcast(message);
  broadcastRoomOneToSpectators(message);
}

function recordRoundWin(loserPlayerId) {
  if (activeRoom.roundWinner) return;

  const winner = opponentPlayerId(loserPlayerId);
  if (!winner) return;

  activeRoom.roundWinner = winner;
  activeRoom.scores[winner] = (activeRoom.scores[winner] ?? 0) + 1;

  const room = activeRoom;
  setTimeout(() => { room.paused = true; }, BARRAGE_CONFIG.postWinSimulationMs ?? 1000);

  broadcast({
    type: "roundEnded",
    roomId: activeRoom.id,
    tick,
    winner,
    loser: loserPlayerId,
    roundNumber: activeRoom.roundNumber,
    scores: activeRoom.scores,
  });

  setTimeout(() => {
    advanceRoomAfterRound(room).catch((error) => {
      console.error(`Failed to advance ${room.id} after round.`, error);
    });
  }, BARRAGE_CONFIG.roundEndDelayMs ?? 5000);
}

async function advanceRoomAfterRound(room) {
  if (!roomManager.isMatched(room)) {
    room.paused = false;
    return;
  }

  room.level = nextLevel(room.level.id);
  room.roundNumber += 1;
  room.roundWinner = null;
  createRoomRuntime(room);
  bindRoom(room);
  await enableHavokPhysics();
  await loadLevelIfPresent();
  await loadFragmentTemplates();
  room.paused = false;
  saveActiveRoomTick();

  broadcast({
    type: "levelChanged",
    roomId: room.id,
    level: room.level.url,
    roundNumber: room.roundNumber,
    scores: room.scores,
  });
  sendState();
}

function maybeRecordKingHit(object, other) {
  const missile = isMissileName(object.id) ? object : isMissileName(other.id) ? other : null;
  const king = isKingName(object.id) ? object : isKingName(other.id) ? other : null;
  if (!missile || !king || missile.loadedInto || activeRoom.roundWinner) return;

  const speed = Math.hypot(missile.vx || 0, missile.vy || 0, missile.vz || 0);
  if (speed < (BARRAGE_CONFIG.kingHitVelocityMin ?? 3)) return;

  missile.hitKingIds ??= new Set();
  if (missile.hitKingIds.has(king.id)) return;
  missile.hitKingIds.add(king.id);

  king.hits = Math.min((king.hits ?? 0) + 1, king.maxHits ?? 3);
  const loser = playerIdForKing(king);

  broadcast({
    type: "event",
    roomId: activeRoom.id,
    tick,
    events: [{
      kind: "kingHit",
      kingId: king.id,
      playerId: loser,
      hits: king.hits,
      maxHits: king.maxHits ?? 3,
    }],
  });

  if (king.hits >= (king.maxHits ?? 3)) {
    recordRoundWin(loser);
  }
}

async function loadFragmentTemplates() {
  if (fragmentTemplateData !== null) return;

  fragmentTemplateData = {};
  for (const [side, file] of [["L", "fragmented_blockL.glb"], ["R", "fragmented_blockR.glb"]]) {
    const fragPath = path.join(assetsDir, file);
    try {
      const glbBuffer = await fs.readFile(fragPath);
      fragmentTemplateData[side] = parseFragmentGlb(glbBuffer);
      console.log(`Loaded ${fragmentTemplateData[side].length} fragment templates from ${file}.`);
    } catch (err) {
      console.warn(`Could not load ${file}: ${err.message}`);
      fragmentTemplateData[side] = [];
    }
  }
}

function parseFragmentGlb(buffer) {
  if (buffer.readUInt32LE(0) !== 0x46546C67) throw new Error("Not a GLB file");

  const jsonChunkLen = buffer.readUInt32LE(12);
  const gltf = JSON.parse(buffer.subarray(20, 20 + jsonChunkLen).toString("utf8"));

  const binStart = (20 + jsonChunkLen + 3) & ~3;
  const binData = buffer.subarray(binStart + 8);

  const templates = [];

  for (const node of gltf.nodes ?? []) {
    if (node.mesh === undefined) continue;
    const mesh = gltf.meshes?.[node.mesh];
    const posAccIdx = mesh?.primitives?.[0]?.attributes?.POSITION;
    if (posAccIdx === undefined) continue;

    const nodeName = node.name ?? mesh.name ?? "";
    const role = childRole(nodeName);
    if (role !== "ColVis" && role !== "Col") continue;

    const accessor = gltf.accessors[posAccIdx];
    const bufView = gltf.bufferViews[accessor.bufferView];
    const byteOffset = (bufView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const count = accessor.count;
    const stride = bufView.byteStride ?? 12;

    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const off = byteOffset + i * stride;
      positions[i * 3]     = binData.readFloatLE(off);
      positions[i * 3 + 1] = binData.readFloatLE(off + 4);
      positions[i * 3 + 2] = binData.readFloatLE(off + 8);
    }

    const [lx = 0, ly = 0, lz = 0] = node.translation ?? [0, 0, 0];

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < count; i++) {
      minX = Math.min(minX, positions[i * 3]);     maxX = Math.max(maxX, positions[i * 3]);
      minY = Math.min(minY, positions[i * 3 + 1]); maxY = Math.max(maxY, positions[i * 3 + 1]);
      minZ = Math.min(minZ, positions[i * 3 + 2]); maxZ = Math.max(maxZ, positions[i * 3 + 2]);
    }

    templates.push({
      localX: lx,
      localY: ly,
      localZ: lz,
      positions,
      offsetX: (minX + maxX) / 2,
      offsetY: (minY + maxY) / 2,
      offsetZ: (minZ + maxZ) / 2,
      halfX: Math.max(0.05, (maxX - minX) / 2),
      halfY: Math.max(0.05, (maxY - minY) / 2),
      halfZ: Math.max(0.05, (maxZ - minZ) / 2),
    });
  }

  return templates;
}

function fragmentBlock(block, missile) {
  if (!fragmentTemplateData) return;
  const side = block.id.toLowerCase().includes("blockl") ? "L" : "R";
  const fragmentTemplates = fragmentTemplateData[side];
  if (!fragmentTemplates?.length) return;

  const rotRad = -(block.rot ?? 0) * Math.PI / 180;
  const cosR = Math.cos(rotRad);
  const sinR = Math.sin(rotRad);
  const fragIds = [];

  for (let i = 0; i < fragmentTemplates.length; i++) {
    const tmpl = fragmentTemplates[i];
    const fragId = `${block.id}_frag_${i}`;

    const worldX = block.x + tmpl.localX * cosR - tmpl.localY * sinR;
    const worldY = block.y + tmpl.localX * sinR + tmpl.localY * cosR;
    const worldZ = block.originZ;

    const spreadX = (Math.random() - 0.5) * 4;
    const spreadY = Math.random() * 2 + 0.5;
    const vx = (missile.vx ?? 0) * 0.5 + spreadX;
    const vy = (missile.vy ?? 0) * 0.3 + spreadY;

    const fragObj = {
      id: fragId,
      x: worldX,
      y: worldY,
      z: worldZ,
      originX: worldX,
      originY: worldY,
      originZ: worldZ,
      rot: block.rot ?? 0,
      vx,
      vy,
      vz: 0,
      angularVelocity: 0,
      dragVx: 0,
      dragVy: 0,
      dragVz: 0,
      dynamic: true,
      isFragment: true,
      parentBlockId: block.id,
      draggedBy: null,
      offsetX: tmpl.offsetX,
      offsetY: tmpl.offsetY,
      offsetZ: tmpl.offsetZ,
      halfX: tmpl.halfX,
      halfY: tmpl.halfY,
      halfZ: tmpl.halfZ,
      halfHeight: tmpl.halfY,
      mass: SERVER_CONFIG.dynamicMass,
      friction: SERVER_CONFIG.dynamicFriction,
      restitution: SERVER_CONFIG.dynamicRestitution,
    };

    gameObjects.set(fragId, fragObj);

    const shapeOptions = {
      mass: SERVER_CONFIG.dynamicMass,
      friction: SERVER_CONFIG.dynamicFriction,
      restitution: SERVER_CONFIG.dynamicRestitution,
    };

    let physNode;
    let shapeType;

    let usedConvex = false;
    if (tmpl.positions?.length > 0) {
      try {
        const hullMesh = new Mesh(`hull-${fragId}`, scene);
        const vd = new VertexData();
        vd.positions = tmpl.positions;
        const numVerts = tmpl.positions.length / 3;
        const indices = [];
        for (let j = 1; j < numVerts - 1; j++) indices.push(0, j, j + 1);
        vd.indices = indices;
        vd.applyToMesh(hullMesh, false);
        hullMesh.position.set(worldX, worldY, worldZ);
        hullMesh.rotationQuaternion = rotationQuaternionForObject(fragObj);
        hullMesh.computeWorldMatrix(true);
        physNode = hullMesh;
        shapeType = PhysicsShapeType.CONVEX_HULL;
        usedConvex = true;
      } catch (err) {
        console.warn(`Convex hull mesh creation failed for frag ${i}:`, err.message);
      }
    }
    if (!usedConvex) {
      physNode = new TransformNode(`physics-${fragId}`, scene);
      physNode.position.set(worldX, worldY, worldZ);
      physNode.rotationQuaternion = rotationQuaternionForObject(fragObj);
      shapeType = PhysicsShapeType.BOX;
      shapeOptions.center = new Vector3(tmpl.offsetX, tmpl.offsetY, tmpl.offsetZ);
      shapeOptions.extents = new Vector3(tmpl.halfX * 2, tmpl.halfY * 2, tmpl.halfZ * 2);
    }

    const aggregate = new PhysicsAggregate(physNode, shapeType, shapeOptions, scene);

    aggregate.body.disablePreStep = true;
    aggregate.body.setLinearDamping(0.15);
    aggregate.body.setAngularDamping(0.55);
    physicsAggregates.set(fragId, aggregate);
    teleportPhysicsBody(aggregate);
    aggregate.body.setLinearVelocity(new Vector3(vx, vy, 0));
    aggregate.body.setAngularVelocity(new Vector3(0, 0, (Math.random() - 0.5) * 12));

    fragIds.push(fragId);
  }

  const blockAgg = physicsAggregates.get(block.id);
  if (blockAgg) {
    blockAgg.dispose();
    physicsAggregates.delete(block.id);
  }
  gameObjects.delete(block.id);

  broadcast({
    type: "event",
    roomId: activeRoom.id,
    tick,
    events: [{ kind: "blockBroken", blockId: block.id, fragIds }],
  });
}

function maybeRecordBlockHit(object, other) {
  const missile = isMissileName(object.id) ? object : isMissileName(other.id) ? other : null;
  const block = isBlockName(object.id) ? object : isBlockName(other.id) ? other : null;
  if (!missile || !block || missile.loadedInto || block.pendingFragment || activeRoom?.roundWinner) return;

  const speed = Math.hypot(missile.vx ?? 0, missile.vy ?? 0, missile.vz ?? 0);
  if (speed < (BARRAGE_CONFIG.blockHitVelocityMin ?? 3)) return;

  missile.hitBlockIds ??= new Set();
  if (missile.hitBlockIds.has(block.id)) return;
  missile.hitBlockIds.add(block.id);

  block.hits = (block.hits ?? 0) + 1;

  broadcast({
    type: "event",
    roomId: activeRoom.id,
    tick,
    events: [{ kind: "blockHit", blockId: block.id, hits: block.hits, maxHits: block.maxHits }],
  });

  if (block.hits >= block.maxHits) {
    block.pendingFragment = missile;
  }
}

function checkMissileBlockHits() {
  const expand = 0.2;
  for (const missile of gameObjects.values()) {
    if (!isMissileName(missile.id) || missile.loadedInto || missile.draggedBy) continue;
    const speed = Math.hypot(missile.vx ?? 0, missile.vy ?? 0, missile.vz ?? 0);
    if (speed < (BARRAGE_CONFIG.blockHitVelocityMin ?? 3)) continue;
    const ma = aabbFor(missile);
    for (const block of gameObjects.values()) {
      if (!isBlockName(block.id) || block.pendingFragment) continue;
      const ba = aabbFor(block);
      if (
        ma.maxX > ba.minX - expand && ma.minX < ba.maxX + expand &&
        ma.maxY > ba.minY - expand && ma.minY < ba.maxY + expand
      ) {
        maybeRecordBlockHit(missile, block);
      }
    }
  }
}

function checkMissileFragmentHits() {
  const expand = 0.2;
  for (const missile of gameObjects.values()) {
    if (!isMissileName(missile.id) || missile.loadedInto || missile.draggedBy) continue;
    const speed = Math.hypot(missile.vx ?? 0, missile.vy ?? 0, missile.vz ?? 0);
    if (speed < (BARRAGE_CONFIG.blockHitVelocityMin ?? 3)) continue;
    const ma = aabbFor(missile);
    for (const fragment of gameObjects.values()) {
      if (!fragment.isFragment || fragment.pendingRemove) continue;
      const fa = aabbFor(fragment);
      if (
        ma.maxX > fa.minX - expand && ma.minX < fa.maxX + expand &&
        ma.maxY > fa.minY - expand && ma.minY < fa.maxY + expand
      ) {
        missile.hitFragIds ??= new Set();
        if (missile.hitFragIds.has(fragment.id)) continue;
        missile.hitFragIds.add(fragment.id);
        fragment.pendingRemove = true;
      }
    }
  }
}

function releaseDrag(object, releaseVelocity) {
  constrainWorldBounds(object);
  returnDraggedObjectUpright(object);
  if (!maybeLoadMissile(object)) {
    setPhysicsBodyTrigger(object, false);
    resolveCollisionsForObject(object, { includeDragged: true });
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
  object.hitKingIds = null;
  object.hitBlockIds = null;
  dragState.delete(object.id);
}

function applyInput(client, message) {
  if (message.type !== "input") return;

  if (message.action === "reset") {
    resetGameState();
    broadcast({
      type: "event",
      tick,
      events: [{ kind: "reset", playerId: client.playerId }],
    });
    return;
  }

  if (message.action === "dragStart") {
    const object = gameObjects.get(message.entityId);
    if (!object || !message.point) return;
    if (!object.dynamic) return;
    if (object.loadedInto) return;
    if (object.isFragment) return;
    if (!canGrab(client.playerId, object)) return;

    object.draggedBy = client.id;
    if (isMissileName(object.id)) {
      setPhysicsBodyTrigger(object, true);
    }
    object.vx = 0;
    object.vy = 0;
    object.vz = 0;
    returnDraggedObjectUpright(object);
    dragState.set(object.id, { lastTime: Date.now(), lastPoint: message.point });
  }

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
    trebuchet.armAngle = restArmAngleForTrebuchet(trebuchet);
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

  if (message.action === "dragMove") {
    const object = gameObjects.get(message.entityId);
    if (!object || !message.point) return;
    if (object.draggedBy !== client.id) return;

    const now = Date.now();
    const previous = dragState.get(object.id);
    const dt = Math.max(0.001, (now - (previous?.lastTime ?? now)) / 1000);
    const next = constrainedPointForObject(object, message.point);

    const side = playerSide(client.playerId);
    if (side && !isInPlayerZone(side, next.x)) {
      object.x = zoneLimitX(side);
      object.y = next.y;
      object.z = next.z;
      releaseDrag(object, { x: 0, y: 0, z: 0 });
      return;
    }

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
    resolveCollisionsForObject(object, { includeDragged: true });
    returnDraggedObjectUpright(object);
    syncPhysicsBodyFromObject(object, { x: 0, y: 0, z: 0 });
    object.vx = 0;
    object.vy = 0;
    object.vz = 0;
    dragState.set(object.id, { lastTime: now, lastPoint: message.point });
  }

  if (message.action === "dragEnd") {
    const object = gameObjects.get(message.entityId);
    if (!object || !message.point) return;
    if (object.draggedBy !== client.id) return;

    const next = constrainedPointForObject(object, message.point);
    object.x = next.x;
    object.y = next.y;
    object.z = next.z;
    releaseDrag(object, usableReleaseVelocity(object, message));
  }

  if (message.action === "fire") {
    broadcast({
      type: "event",
      tick,
      events: [
        {
          kind: "fire",
          playerId: client.playerId,
          start: message.start,
          end: message.end,
        },
      ],
    });
  }
}

function updateTrebuchetAim(trebuchet, point) {
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

function beginTrebuchetRelease(trebuchet) {
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

function releaseLoadedMissileFromTrebuchet(trebuchet, velocity, armAngle = null) {
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

function registerMeshRoots() {
  loadTargets.clear();
  physicsAggregates.clear();

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

  const candidateRoots = [
    ...scene.transformNodes.filter((transform) => !transform.parent || transform.parent.name === "__root__"),
    ...scene.meshes.filter((mesh) => !mesh.parent || mesh.parent.name === "__root__"),
  ];
  const seenRootNames = new Set();

  for (const transform of candidateRoots) {
    if (transform.name === "__root__") continue;
    if (seenRootNames.has(transform.name)) continue;
    seenRootNames.add(transform.name);

    const hasGameplayRole = Boolean(childRole(transform.name))
      || descendantsOf(transform).some((child) => childRole(child.name));

    if (!hasGameplayRole) continue;

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
        armAngle: restArmAngleForTrebuchet(transform),
        aimedBy: null,
        aimStart: null,
        aimCurrent: null,
        pendingShot: null,
        returnStartArmAngle: null,
        releaseElapsedMs: 0,
      } : {}),
      ...(isMissileName(transform.name) ? { loadedInto: null } : {}),
      ...(isKingName(transform.name) ? { hits: 0, maxHits: 3 } : {}),
      ...(isBlockName(transform.name) ? { hits: 0, maxHits: BARRAGE_CONFIG.blockMaxHits ?? 3, pendingFragment: null } : {}),
    });
  }

  createPhysicsBodies();
}

function createPhysicsBodies() {
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

function findAncestor(node, predicate) {
  let current = node.parent;

  while (current) {
    if (predicate(current.name)) return current;
    current = current.parent;
  }

  return null;
}

function findGameplayRootAncestor(node) {
  let current = node.parent;
  let candidate = null;

  while (current) {
    if (isTrebuchetName(current.name)) {
      candidate = current;
    }

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
    if (isTrebuchetArmRoot(current)) {
      return current;
    }

    current = current.parent;
  }

  return null;
}

function resetGameState() {
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
    if (object.armAngle !== undefined) object.armAngle = restArmAngleForTrebuchet(object);
    if (object.fireState !== undefined) object.fireState = ARM_STATE_IDLE;
    if (object.loadedMissileId !== undefined) object.loadedMissileId = null;
    if (object.aimedBy !== undefined) object.aimedBy = null;
    if (object.aimStart !== undefined) object.aimStart = null;
    if (object.aimCurrent !== undefined) object.aimCurrent = null;
    if (object.pendingShot !== undefined) object.pendingShot = null;
    if (object.returnStartArmAngle !== undefined) object.returnStartArmAngle = null;
    if (object.releaseElapsedMs !== undefined) object.releaseElapsedMs = 0;

    if (object.hits !== undefined) object.hits = 0;
    if (object.pendingFragment !== undefined) object.pendingFragment = null;

    syncPhysicsBodyFromObject(object, { x: 0, y: 0, z: 0 });
  }
}

function resolveObjectCollision(object, other, { preferHorizontal = false } = {}) {
  if (object.id === other.id || isGroundName(other.id)) return;

  const a = aabbFor(object);
  const b = aabbFor(other);
  const overlapX = overlapOnAxis(a.minX, a.maxX, b.minX, b.maxX);
  const overlapY = overlapOnAxis(a.minY, a.maxY, b.minY, b.maxY);
  const overlapZ = overlapOnAxis(a.minZ, a.maxZ, b.minZ, b.maxZ);

  if (overlapX <= 0 || overlapY <= 0 || overlapZ <= 0) return;

  maybeRecordKingHit(object, other);
  maybeRecordBlockHit(object, other);

  const centerAX = object.x + object.offsetX;
  const centerAY = object.y + object.offsetY;
  const centerAZ = object.z + object.offsetZ;
  const centerBX = other.x + other.offsetX;
  const centerBY = other.y + other.offsetY;
  const centerBZ = other.z + other.offsetZ;

  function resolveDynamicImpact(axis, direction, overlap) {
    if (object.draggedBy || other.draggedBy || !other.dynamic) return false;
    if (axis === "y" && (isTrebuchetName(object.id) || isTrebuchetName(other.id))) return false;
    if (isTrebuchetName(other.id) && axis !== "x") return false;

    const objectBefore = object[axis];
    const otherBefore = other[axis];
    const objectShare = isTrebuchetName(object.id) ? 0 : 0.5;
    const otherShare = isTrebuchetName(other.id) ? 0 : 1 - objectShare;

    object[axis] += overlap * direction * objectShare;
    other[axis] -= overlap * direction * otherShare;

    if (isTrebuchetName(object.id)) {
      const constrained = constrainedPointForObject(object, { x: object.x, y: object.y, z: object.z });
      object.x = constrained.x;
      object.y = constrained.y;
      object.z = constrained.z;
    }

    if (isTrebuchetName(other.id)) {
      const constrained = constrainedPointForObject(other, { x: other.x, y: other.y, z: other.z });
      other.x = constrained.x;
      other.y = constrained.y;
      other.z = constrained.z;
    }

    const objectMoved = Math.abs(object[axis] - objectBefore) > 0.0001;
    const otherMoved = Math.abs(other[axis] - otherBefore) > 0.0001;
    if (!objectMoved && !otherMoved) return false;

    const objectVelocity = velocityComponent(object, axis);
    const otherVelocity = velocityComponent(other, axis);
    const relativeNormalVelocity = (objectVelocity - otherVelocity) * direction;
    if (relativeNormalVelocity >= 0) return true;

    const transfer = BARRAGE_CONFIG.impactVelocityTransfer ?? 0.75;
    const restitution = Math.max(object.restitution ?? 0, other.restitution ?? 0);
    const invMassA = object.mass > 0 ? 1 / object.mass : 0;
    const invMassB = other.mass > 0 ? 1 / other.mass : 0;
    const invMassSum = invMassA + invMassB;
    if (invMassSum <= 0) return true;

    const impulse = (-(1 + restitution) * relativeNormalVelocity * transfer) / invMassSum;
    setVelocityComponent(object, axis, objectVelocity + impulse * direction * invMassA);
    setVelocityComponent(other, axis, otherVelocity - impulse * direction * invMassB);

    return true;
  }

  function moveOtherOrBlock(axis, delta) {
    if (object.draggedBy && isMissileName(object.id) && isTrebuchetName(other.id)) {
      object[axis] -= delta;
      if (axis === "x") object.vx = 0;
      if (axis === "y") object.vy = 0;
      if (axis === "z") object.vz = 0;
      return;
    }

    if (other.dynamic && !other.draggedBy) {
      const before = { x: other.x, y: other.y, z: other.z };

      if (axis === "x") {
        other.x += delta;
      } else if (axis === "y" && !isTrebuchetName(other.id)) {
        other.y += delta;
      } else if (axis === "z" && !isTrebuchetName(other.id)) {
        other.z += delta;
      }

      if (isTrebuchetName(other.id)) {
        const constrained = constrainedPointForObject(other, { x: other.x, y: other.y, z: other.z });
        other.x = constrained.x;
        other.y = constrained.y;
        other.z = constrained.z;
      }

      const moved = other[axis] - before[axis];
      if (Math.abs(moved) > 0.0001) {
        const pushedScale = isTrebuchetName(other.id) ? SERVER_CONFIG.pushedTrebuchetVelocityScale : 1;
        const inheritedVelocity = clampVector({
          x: (object.dragVx || object.vx) * pushedScale,
          y: (object.dragVy || object.vy) * pushedScale,
          z: (object.dragVz || object.vz) * pushedScale,
        }, normalReleaseVelocityMax());

        if (axis === "x") other.vx = inheritedVelocity.x;
        if (axis === "y") other.vy = inheritedVelocity.y;
        if (axis === "z") other.vz = inheritedVelocity.z;
        return;
      }
    }

    object[axis] -= delta;
    if (axis === "x") object.vx = 0;
    if (axis === "y") object.vy = 0;
    if (axis === "z") object.vz = 0;
  }

  if (!preferHorizontal && overlapY <= overlapX && overlapY <= overlapZ) {
    const direction = centerAY >= centerBY ? 1 : -1;
    const delta = overlapY * direction;
    if (object.draggedBy) {
      moveOtherOrBlock("y", -delta);
    } else if (resolveDynamicImpact("y", direction, overlapY)) {
      return;
    } else {
      object.y += delta;
    }
    if ((direction > 0 && object.vy < 0) || (direction < 0 && object.vy > 0)) {
      object.vy = 0;
    }
    object.vx *= Math.max(0, 1 - object.friction * 0.08);
    object.vz *= Math.max(0, 1 - object.friction * 0.08);
    return;
  }

  if (overlapX <= overlapZ) {
    const direction = centerAX >= centerBX ? 1 : -1;
    const delta = overlapX * direction;
    if (object.draggedBy) {
      moveOtherOrBlock("x", -delta);
    } else if (resolveDynamicImpact("x", direction, overlapX)) {
      return;
    } else {
      object.x += delta;
    }
    if ((direction > 0 && object.vx < 0) || (direction < 0 && object.vx > 0)) {
      object.vx = 0;
    }
    return;
  }

  const direction = centerAZ >= centerBZ ? 1 : -1;
  const delta = overlapZ * direction;
  if (object.draggedBy) {
    moveOtherOrBlock("z", -delta);
  } else if (resolveDynamicImpact("z", direction, overlapZ)) {
    return;
  } else {
    object.z += delta;
  }
  if ((direction > 0 && object.vz < 0) || (direction < 0 && object.vz > 0)) {
    object.vz = 0;
  }
}

function resolveCollisionsForObject(object, { includeDragged = false } = {}) {
  if (object.loadedInto) return;
  if (!object.dynamic || (!includeDragged && object.draggedBy) || isTrebuchetName(object.id)) return;

  for (const other of gameObjects.values()) {
    if (other.id === object.id) continue;
    if (other.loadedInto) continue;
    if (!includeDragged && other.draggedBy) continue;
    resolveObjectCollision(object, other, { preferHorizontal: Boolean(object.draggedBy) });
  }
}

function resolveCollisions() {
  const objects = [...gameObjects.values()];

  for (let i = 0; i < SERVER_CONFIG.collisionIterations; i += 1) {
    for (const object of objects) {
      resolveCollisionsForObject(object);
    }
  }
}

function syncPhysicsBodyFromObject(object, velocity = null) {
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

function teleportPhysicsBody(aggregate) {
  aggregate.body.setPrestepType(PhysicsPrestepType.TELEPORT);
  aggregate.body._physicsPlugin.setPhysicsBodyTransformation(aggregate.body, aggregate.transformNode);
  aggregate.body.setPrestepType(PhysicsPrestepType.DISABLED);
}

function setPhysicsBodyTrigger(object, isTrigger) {
  const aggregate = physicsAggregates.get(object.id);
  if (!aggregate?.shape) return;

  aggregate.shape.isTrigger = isTrigger;
}

function constrainBodyToPlane(object) {
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

function simulateHavokPhysics() {
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
  }
}

function simulatePhysics(dt) {
  const scaledDt = dt * (BARRAGE_CONFIG.physicsTimeScale ?? 1);

  if (physicsAggregates.size > 0) {
    simulateHavokPhysics();
    return;
  }

  updateTrebuchetFireState(scaledDt);

  for (const object of gameObjects.values()) {
    if (!object.dynamic || object.draggedBy) continue;
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
      continue;
    }

    if (isTrebuchetName(object.id)) {
      object.x += object.vx * scaledDt;
      object.x = constrainedPointForObject(object, { x: object.x, y: object.y, z: object.z }).x;
      object.y = object.originY;
      object.z = object.originZ;
      object.vx *= Math.max(0, 1 - SERVER_CONFIG.trebuchetReleaseFriction * scaledDt);
      if (Math.abs(object.vx) < 0.01) object.vx = 0;
      object.vy = 0;
      object.vz = 0;
      continue;
    }

    object.vy += SERVER_CONFIG.gravity * scaledDt;
    object.x += object.vx * scaledDt;
    object.y += object.vy * scaledDt;
    object.z += object.vz * scaledDt;
    constrainWorldBounds(object);

    const floorY = SERVER_CONFIG.groundY + object.halfY - object.offsetY;
    if (object.y < floorY) {
      object.y = floorY;

      if (Math.abs(object.vy) > 0.4) {
        object.vy = -object.vy * object.restitution;
      } else {
        object.vy = 0;
      }

      const frictionScale = Math.max(0, 1 - object.friction * scaledDt * 3);
      object.vx *= frictionScale;
      object.vz *= frictionScale;

      if (Math.abs(object.vx) < 0.01) object.vx = 0;
      if (Math.abs(object.vz) < 0.01) object.vz = 0;
    }
  }

  resolveCollisions();
}

function updateTrebuchetFireState(dt) {
  for (const trebuchet of gameObjects.values()) {
    if (!isTrebuchetName(trebuchet.id)) continue;

    if (trebuchet.fireState === ARM_STATE_RETURNING) {
      const durationMs = Math.max(1, BARRAGE_CONFIG.fireReturnAnimationMs ?? 220);
      trebuchet.releaseElapsedMs = (trebuchet.releaseElapsedMs ?? 0) + dt * 1000;
      const progress = clamp(trebuchet.releaseElapsedMs / durationMs, 0, 1);
      const startArmAngle = trebuchet.returnStartArmAngle ?? trebuchet.armAngle ?? 0;
      const restArmAngle = restArmAngleForTrebuchet(trebuchet);
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

async function loadLevelIfPresent() {
  const room = activeRoom;
  const level = room.level;
  const levelPath = path.join(assetsDir, level.file);

  try {
    await fs.access(levelPath);
  } catch {
    console.log(`No GLB found at public/assets/${level.file}; ${room.id} starting with an empty scene.`);
    return;
  }

  await SceneLoader.AppendAsync(`http://localhost:${PORT}/assets/`, level.file, room.scene);
  bindRoom(room);
  applyTrebuchetArmRestPose();
  registerMeshRoots();
  console.log(`Loaded ${level.file} for ${room.id} with ${gameObjects.size} gameplay objects.`);
  for (const object of gameObjects.values()) {
    console.log(
      `${room.id} object ${object.id}: dynamic=${object.dynamic} pos=(${object.x.toFixed(2)}, ${object.y.toFixed(2)}, ${object.z.toFixed(2)}) half=(${object.halfX.toFixed(2)}, ${object.halfY.toFixed(2)}, ${object.halfZ.toFixed(2)}) offset=(${object.offsetX.toFixed(2)}, ${object.offsetY.toFixed(2)}, ${object.offsetZ.toFixed(2)})`,
    );
  }
}

async function enableHavokPhysics() {
  const room = activeRoom;
  havokInterfacePromise ??= fs
    .readFile(path.join(__dirname, "node_modules/@babylonjs/havok/lib/esm/HavokPhysics.wasm"))
    .then((wasmBinary) => HavokPhysics({ wasmBinary }));

  const havokInterface = await havokInterfacePromise;
  bindRoom(room);
  const havokPlugin = new HavokPlugin(true, havokInterface);
  scene.enablePhysics(new Vector3(0, SERVER_CONFIG.gravity, 0), havokPlugin);
}

function sendToClient(client, message) {
  if (client.socket.readyState === client.socket.OPEN) {
    client.socket.send(JSON.stringify(message));
  }
}

function roomOpponentFor(client) {
  for (const other of client.room.clients.values()) {
    if (other.id !== client.id) return other;
  }

  return null;
}

function sendWelcome(client) {
  sendToClient(client, {
    type: "welcome",
    clientId: client.id,
    playerId: client.playerId,
    tickRate: TICK_RATE,
  });
}

function sendLobby(client) {
  if (!client.room) {
    const room = roomManager.rooms[0] ?? null;
    sendToClient(client, {
      type: "lobby",
      roomId: room?.id ?? null,
      playerId: client.playerId,
      status: "spectating",
      level: room?.level.url ?? firstLevel().url,
    });
    return;
  }

  sendToClient(client, {
    type: "lobby",
    roomId: client.room.id,
    playerId: client.playerId,
    status: "waiting",
    level: client.room.level.url,
  });
}

function notifySpectatorRenames(clientsToNotify) {
  for (const client of clientsToNotify) {
    sendWelcome(client);
    sendLobby(client);
  }
}

function broadcastRoomOneToSpectators(message) {
  if (activeRoom !== roomManager.rooms[0]) return;

  const payload = JSON.stringify(message);
  for (const client of roomManager.spectators.values()) {
    if (client.socket.readyState === client.socket.OPEN) {
      client.socket.send(payload);
    }
  }
}

async function resetRoomToFirstLevel(room) {
  resetRoomProgress(room);
  createRoomRuntime(room);
  bindRoom(room);
  await enableHavokPhysics();
  await loadLevelIfPresent();
  saveActiveRoomTick();
}

function sendMatched(room) {
  for (const client of room.clients.values()) {
    const opponent = roomOpponentFor(client);
    sendToClient(client, {
      type: "matched",
      roomId: room.id,
      playerId: client.playerId,
      opponentId: opponent?.playerId ?? null,
      level: room.level.url,
      roundNumber: room.roundNumber,
      scores: room.scores,
    });
  }
}

function notifyRoomStatus(room) {
  if (roomManager.isMatched(room)) {
    bindRoom(room);
    room.paused = false;
    room.roundWinner = null;
    resetGameState();
    saveActiveRoomTick();
    sendMatched(room);
    sendState();
    return;
  }

  for (const client of room.clients.values()) {
    sendLobby(client);
  }
}

function compactAndNotifyWaitingRooms() {
  const moves = roomManager.compactWaitingRooms();
  if (moves.length === 0) return false;

  const touchedRooms = new Set();
  for (const move of moves) {
    touchedRooms.add(move.sourceRoom);
    touchedRooms.add(move.targetRoom);
  }

  for (const room of touchedRooms) {
    notifyRoomStatus(room);
  }

  return true;
}

async function handlePlayerVacancy({ room, playerId }) {
  const promotion = roomManager.promoteSpectatorToSlot(room, playerId);
  if (promotion) {
    const { spectator: promoted, spectatorRenames } = promotion;
    sendWelcome(promoted);
    notifySpectatorRenames(spectatorRenames);
    await resetRoomToFirstLevel(room);
    notifyRoomStatus(room);
    return;
  }

  if (!compactAndNotifyWaitingRooms()) {
    notifyRoomStatus(room);
  }
}

wss.on("connection", (socket) => {
  const clientId = nextClientId++;
  const client = { id: clientId, playerId: null, room: null, socket };
  clients.set(clientId, client);

  roomManager.assignClient(client).then(({ room, becameMatched, spectator }) => {
    sendWelcome(client);
    if (spectator) {
      sendLobby(client);
    } else if (becameMatched) {
      notifyRoomStatus(room);
    } else if (!roomManager.isMatched(room)) {
      sendLobby(client);
    }

    socket.on("message", (raw) => {
      try {
        if (!client.room || !roomManager.isMatched(client.room)) return;
        bindRoom(client.room);
        applyInput(client, JSON.parse(raw.toString()));
        saveActiveRoomTick();
      } catch (error) {
        sendToClient(client, { type: "error", message: "Invalid message JSON" });
      }
    });

    socket.on("close", () => {
      clients.delete(clientId);
      const removal = roomManager.removeClient(client);
      if (removal?.room) {
        handlePlayerVacancy(removal).catch((error) => {
          console.error("Failed to handle player vacancy.", error);
        });
      } else if (removal?.spectatorRenames) {
        notifySpectatorRenames(removal.spectatorRenames);
      }
    });
  }).catch((error) => {
    console.error("Failed to assign client to room.", error);
    sendToClient(client, { type: "error", message: "Failed to join a room" });
    closeSocket(socket);
  });
});

async function startServer() {
  await new Promise((resolve) => {
    httpServer.listen(PORT, () => {
      console.log(`Barrage server running at http://localhost:${PORT}`);
      resolve();
    });
  });

  simulationInterval = setInterval(() => {
    for (const room of roomManager.activeRooms()) {
      bindRoom(room);
      tick += 1;
      simulatePhysics(TICK_MS / 1000);
      checkMissileBlockHits();
      checkMissileFragmentHits();
      for (const object of [...gameObjects.values()]) {
        if (object.pendingFragment) {
          try {
            fragmentBlock(object, object.pendingFragment);
          } catch (err) {
            console.error(`fragmentBlock failed for ${object.id}:`, err);
            object.pendingFragment = null;
          }
        }
        if (object.pendingRemove && object.isFragment) {
          const agg = physicsAggregates.get(object.id);
          if (agg) {
            agg.dispose();
            physicsAggregates.delete(object.id);
          }
          gameObjects.delete(object.id);
          broadcast({
            type: "event",
            roomId: activeRoom.id,
            tick,
            events: [{ kind: "fragmentHit", fragId: object.id }],
          });
        }
      }
      const knockedKing = checkKingKnockout(gameObjects);
      if (knockedKing) recordRoundWin(playerIdForKing(knockedKing));
      sendState();
      saveActiveRoomTick();
    }
  }, TICK_MS);
}

startServer().catch((error) => {
  console.error("Failed to start Barrage server.", error);
  process.exit(1);
});
