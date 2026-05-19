import express from "express";
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import xhr2 from "xhr2";
import { WebSocketServer } from "ws";
import HavokPhysics from "@babylonjs/havok";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin.js";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate.js";
import { PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin.js";
import "@babylonjs/core/Physics/v2/physicsEngineComponent.js";
import { SERVER_CONFIG } from "./config/server.js";
import { BARRAGE_CONFIG } from "./public/config.js";
import { firstLevel, nextLevel } from "./server/levelCatalog.js";
import { RoomManager } from "./server/roomManager.js";
import { playerSide, canGrab, isInPlayerZone, zoneLimitX, checkKingKnockout, isMatchWin } from "./server/gameManager.js";
import { createFragmentSystem } from "./server/fragments.js";
import { createInputHandler } from "./server/input.js";
import { createNetworkMessenger } from "./server/network-messages.js";
import { createPhysicsBodySystem } from "./server/physics-bodies.js";
import { createRoomLifecycle } from "./server/room-lifecycle.js";
import {
  createRoomRuntime,
  createRoomState as createRoomStateFromInfo,
  resetRoomProgress as resetRoomProgressState,
} from "./server/room-state.js";
import {
  applyMagneticDragForce as resolveApplyMagneticDragForce,
  constrainedPointForObject as resolveConstrainedPointForObject,
  constrainWorldBounds as resolveConstrainWorldBounds,
  localPointForObject as resolveLocalPointForObject,
  moveMissileReleaseTowardOriginUntilClear as resolveMoveMissileReleaseTowardOriginUntilClear,
  usableReleaseVelocity as resolveUsableReleaseVelocity,
  usesMagneticDrag,
} from "./server/drag.js";
import {
  beginTrebuchetRelease as resolveBeginTrebuchetRelease,
  loadTargetForTrebuchet as resolveLoadTargetForTrebuchet,
  maybeLoadMissile as resolveMaybeLoadMissile,
  updateTrebuchetAim as resolveUpdateTrebuchetAim,
} from "./server/trebuchet.js";
import {
  childRole,
  clamp,
  clampAngularVelocity,
  isBlockName,
  isDynamicName,
  isGroundName,
  isKingName,
  isLeftSideKingName,
  isMissileBombName,
  isMissileName,
  isTrebuchetName,
  lerp,
  lerpAngleDegrees,
  restArmAngleForTrebuchet,
  rotationQuaternionForObject,
} from "./server/utils.js";
import {
  createPhysicsContactRecorder,
  handlePhysicsContacts as handleCollisionContacts,
} from "./server/collision-events.js";
import {
  appendServerLevelGlb,
  colliderBoundsFor,
  descendantsOf,
  estimateHalfHeight,
  extractConvexPositions as extractConvexPositionsFromGlb,
  findGameplayRootAncestor,
  findTrebuchetArmAncestor,
  isTrebuchetArmRoot,
  parseFragmentGlb as parseFragmentGlbData,
} from "./server/glb-parser.js";
import { createSimulationRunner } from "./server/simulation.js";
import {
  createSoundEventDispatcher,
  impactPositionFor,
  impactSpeedFor,
} from "./server/server-events.js";

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

const recentLogs = [];
const _origLog = console.log.bind(console);
console.log = (...args) => {
  _origLog(...args);
  recentLogs.push(`[${new Date().toISOString()}] ${args.join(" ")}`);
  if (recentLogs.length > 200) recentLogs.shift();
};

app.get("/debug/logs", (_req, res) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(recentLogs.join("\n") || "(no logs yet)");
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
let initialBlockObjects = null;
let initialMissileObjects = null;
let kingConvexPositions = new Map();
let loadTargets = null;
let physicsAggregates = null;
let physicsCollisionObservers = null;
let physicsContactEvents = null;
let impactSoundTicks = null;
let havokInterfacePromise = null;

const ARM_STATE_IDLE = "idle";
const ARM_STATE_AIMING = "aiming";
const ARM_STATE_RELEASING = "releasing";
const ARM_STATE_RETURNING = "returning";
const recordPhysicsContactEvent = createPhysicsContactRecorder({
  getPhysicsContactEvents: () => physicsContactEvents,
  getTick: () => tick,
});

function resetRoomProgress(room) {
  resetRoomProgressState(room, { firstLevel });
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
  physicsCollisionObservers = room.physicsCollisionObservers;
  physicsContactEvents = room.physicsContactEvents;
  impactSoundTicks = room.impactSoundTicks;
}

function saveActiveRoomTick() {
  if (activeRoom) {
    activeRoom.tick = tick;
  }
}

const roomManager = new RoomManager({
  async createRoom(roomInfo) {
    const room = createRoomStateFromInfo({ roomInfo, firstLevel });
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

function localPointForObject(object, point) {
  return resolveLocalPointForObject(object, point, { physicsAggregates });
}

function constrainWorldBounds(object) {
  resolveConstrainWorldBounds(object, { serverConfig: SERVER_CONFIG });
}

function usableReleaseVelocity(object, message) {
  return resolveUsableReleaseVelocity(object, message, { dragState });
}

function constrainedPointForObject(object, point) {
  return resolveConstrainedPointForObject(object, point, {
    config: BARRAGE_CONFIG,
    serverConfig: SERVER_CONFIG,
  });
}

function moveMissileReleaseTowardOriginUntilClear(object) {
  return resolveMoveMissileReleaseTowardOriginUntilClear(object, {
    config: BARRAGE_CONFIG,
    gameObjects,
  });
}

function distance3(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function loadTargetForTrebuchet(trebuchet) {
  return resolveLoadTargetForTrebuchet(trebuchet, { loadTargets });
}

function maybeLoadMissile(missile) {
  return resolveMaybeLoadMissile(missile, {
    armStateIdle: ARM_STATE_IDLE,
    config: BARRAGE_CONFIG,
    gameObjects,
    loadTargetForTrebuchet,
    setPhysicsBodyTrigger,
  });
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

const {
  broadcastImpactSoundEffect,
  broadcastSoundEffect,
  broadcastSoundEffectStart,
  maybeBroadcastGroundImpactSound,
  maybeBroadcastObjectImpactSound,
  stopTrebuchetStretchSound,
} = createSoundEventDispatcher({
  broadcast,
  config: BARRAGE_CONFIG,
  getActiveRoom: () => activeRoom,
  getImpactSoundTicks: () => impactSoundTicks,
  getTick: () => tick,
  tickMs: TICK_MS,
});

const {
  broadcastRoomOneToSpectators,
  notifySpectatorRenames,
  sendLobby,
  sendMatched,
  sendToClient,
  sendWelcome,
} = createNetworkMessenger({
  firstLevel,
  getActiveRoom: () => activeRoom,
  getPrimaryRoom: () => roomManager.rooms[0] ?? null,
  getSpectators: () => roomManager.spectators,
  tickRate: TICK_RATE,
});

const {
  angularDampingForObject,
  createPhysicsBodies,
  disposeAllPhysicsAggregates,
  disposePhysicsAggregate,
  massForObject,
  physicsVelocityForObject,
  registerPhysicsAggregate,
  setPhysicsBodyTrigger,
  syncObjectFromPhysicsBody,
  syncPhysicsBodyFromObject,
  teleportPhysicsBody,
} = createPhysicsBodySystem({
  config: BARRAGE_CONFIG,
  gameObjects: () => gameObjects,
  getScene: () => scene,
  kingConvexPositions: () => kingConvexPositions,
  physicsAggregates: () => physicsAggregates,
  physicsCollisionObservers: () => physicsCollisionObservers,
  recordPhysicsContactEvent,
  serverConfig: SERVER_CONFIG,
});

const {
  fragmentBlock,
  loadFragmentTemplates,
  maybeRecordBlockHit,
  maybeRecordFragmentHit,
  processBombDetonations,
  updateFragmentColliderShrinks,
} = createFragmentSystem({
  assetsDir,
  broadcast,
  broadcastImpactSoundEffect,
  config: BARRAGE_CONFIG,
  disposePhysicsAggregate,
  fs,
  gameObjects: () => gameObjects,
  getActiveRoom: () => activeRoom,
  getScene: () => scene,
  getTick: () => tick,
  isKingName,
  onBombKingKill: recordBombKingKill,
  path,
  physicsAggregates: () => physicsAggregates,
  parseFragmentGlb: (buffer) => parseFragmentGlbData(buffer, { childRole }),
  registerPhysicsAggregate,
  serverConfig: SERVER_CONFIG,
  teleportPhysicsBody,
  tickMs: TICK_MS,
});

const { runRoomSimulationTick } = createSimulationRunner({
  bindRoom,
  broadcast,
  broadcastImpactSoundEffect,
  checkKingKnockout,
  disposePhysicsAggregate,
  fragmentBlock,
  getActiveRoom: () => activeRoom,
  getGameObjects: () => gameObjects,
  getPhysicsContactEvents: () => physicsContactEvents,
  getTick: () => tick,
  handlePhysicsContacts,
  impactSpeedFor,
  incrementTick: () => {
    tick += 1;
    return tick;
  },
  physicsVelocityForObject,
  playerIdForKing,
  processBombDetonations,
  recordRoundWin,
  saveActiveRoomTick,
  sendState,
  simulatePhysics,
  tickMs: TICK_MS,
  updateFragmentColliderShrinks,
});

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

const {
  handlePlayerVacancy,
  notifyRoomStatus,
} = createRoomLifecycle({
  bindRoom,
  compactWaitingRooms: () => roomManager.compactWaitingRooms(),
  createRoomRuntime,
  enableHavokPhysics,
  isMatched: (room) => roomManager.isMatched(room),
  loadFragmentTemplates,
  loadLevelIfPresent,
  notifySpectatorRenames,
  promoteSpectatorToSlot: (room, playerId) => roomManager.promoteSpectatorToSlot(room, playerId),
  resetGameState,
  resetRoomProgress,
  saveActiveRoomTick,
  sendLobby,
  sendMatched,
  sendState,
  sendWelcome,
});

function endMatchByDisconnect(room, loserPlayerId, opponentId) {
  console.log(`[endMatchByDisconnect] room=${room.id} loser=${loserPlayerId} opponent=${opponentId} roundWinner=${room.roundWinner} matchEnded=${room.matchEnded} clientsHasOpponent=${room.clients.has(opponentId)}`);
  if (room.roundWinner || room.matchEnded) return;
  if (!room.clients.has(opponentId)) return; // opponent also left during grace period
  room.roundWinner = opponentId;
  room.matchEnded = true;
  room.paused = true;
  bindRoom(room);
  console.log(`[endMatchByDisconnect] broadcasting roundEnded matchWon to ${room.clients.size} clients`);
  broadcast({
    type: "roundEnded",
    roomId: room.id,
    tick,
    winner: opponentId,
    loser: loserPlayerId,
    roundNumber: room.roundNumber,
    scores: room.scores,
    matchWon: true,
  });
  const matchEndDelayMs = BARRAGE_CONFIG.matchEndDelayMs ?? 14000;
  setTimeout(() => {
    for (const c of room.clients.values()) {
      try { c.socket.send(JSON.stringify({ type: "matchOver" })); } catch { /* ignore */ }
      closeSocket(c.socket);
    }
  }, matchEndDelayMs);
}

function recordRoundWin(loserPlayerId, { forfeit = false } = {}) {
  if (activeRoom.roundWinner) return;

  const winner = opponentPlayerId(loserPlayerId);
  if (!winner) return;

  activeRoom.roundWinner = winner;
  activeRoom.scores[winner] = (activeRoom.scores[winner] ?? 0) + 1;

  const room = activeRoom;
  const matchWin = isMatchWin(activeRoom.scores, winner);

  setTimeout(() => { room.paused = true; }, BARRAGE_CONFIG.postWinSimulationMs ?? 1000);

  broadcast({
    type: "roundEnded",
    roomId: activeRoom.id,
    tick,
    winner,
    loser: loserPlayerId,
    roundNumber: activeRoom.roundNumber,
    scores: activeRoom.scores,
    ...(matchWin && { matchWon: true }),
    ...(forfeit && { forfeit: true }),
  });

  if (matchWin) {
    const matchEndDelayMs = BARRAGE_CONFIG.matchEndDelayMs ?? 14000;
    setTimeout(() => {
      for (const client of room.clients.values()) {
        try { client.socket.send(JSON.stringify({ type: "matchOver" })); } catch { /* ignore */ }
        closeSocket(client.socket);
      }
    }, matchEndDelayMs);
  } else {
    setTimeout(() => {
      advanceRoomAfterRound(room).catch((error) => {
        console.error(`Failed to advance ${room.id} after round.`, error);
      });
    }, BARRAGE_CONFIG.roundEndDelayMs ?? 5000);
  }
}

async function reloadRoom() {
  const room = activeRoom;
  if (!room || !roomManager.isMatched(room)) return;
  room.paused = true;
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
    forceReload: true,
  });
  sendState();
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

function recordBombKingKill(king, position) {
  if (!king || activeRoom.roundWinner) return;
  const loser = playerIdForKing(king);
  if (!loser) return;
  broadcastImpactSoundEffect("king_hit", position, BARRAGE_CONFIG.missileBombTriggerSpeed ?? 10);
  broadcast({
    type: "event",
    roomId: activeRoom.id,
    tick,
    events: [{
      kind: "kingHit",
      kingId: king.id,
      playerId: loser,
      hits: king.maxHits ?? 3,
      maxHits: king.maxHits ?? 3,
    }],
  });
  recordRoundWin(loser);
}

function maybeRecordKingHit(object, other, hitPosition = null) {
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
  broadcastImpactSoundEffect("king_hit", hitPosition ?? impactPositionFor(missile, king), impactSpeedFor(missile, king));

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

function handlePhysicsContacts(contacts) {
  handleCollisionContacts(contacts, {
    blockHitVelocityMin: BARRAGE_CONFIG.blockHitVelocityMin ?? 3,
    gameObjects,
    impactSpeedFor,
    isBlockName,
    isGroundName,
    isKingName,
    isMissileBombName,
    isMissileName,
    isTrebuchetName,
    missileBombMinSpeed: BARRAGE_CONFIG.missileBombTriggerSpeed ?? 2,
    maybeBroadcastGroundImpactSound,
    maybeBroadcastObjectImpactSound,
    maybeRecordBlockHit,
    maybeRecordFragmentHit,
    maybeRecordKingHit,
  });
}

function releaseDrag(object, releaseVelocity) {
  if (usesMagneticDrag(object)) {
    object.dragVx = 0;
    object.dragVy = 0;
    object.dragVz = 0;
    object.draggedBy = null;
    dragState.delete(object.id);
    return;
  }

  constrainWorldBounds(object);
  if (!maybeLoadMissile(object)) {
    moveMissileReleaseTowardOriginUntilClear(object);
    object.vx = releaseVelocity.x;
    object.vy = releaseVelocity.y;
    object.vz = releaseVelocity.z;
    syncPhysicsBodyFromObject(object, releaseVelocity);
    setPhysicsBodyTrigger(object, false);
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

const applyInput = createInputHandler({
  armStateAiming: ARM_STATE_AIMING,
  armStateReleasing: ARM_STATE_RELEASING,
  beginTrebuchetRelease,
  broadcast,
  broadcastSoundEffectStart,
  canGrab,
  constrainedPointForObject,
  constrainWorldBounds,
  dragState: () => dragState,
  gameObjects: () => gameObjects,
  getActiveRoom: () => activeRoom,
  getTick: () => tick,
  isInPlayerZone,
  isMissileName,
  loadTargetForTrebuchet,
  localPointForObject,
  physicsAggregates: () => physicsAggregates,
  playerSide,
  releaseDrag,
  reloadRoom,
  restArmAngleForTrebuchet,
  setPhysicsBodyTrigger,
  stopTrebuchetStretchSound,
  syncPhysicsBodyFromObject,
  updateTrebuchetAim,
  usableReleaseVelocity,
  usesMagneticDrag,
  zoneLimitX,
});

function updateTrebuchetAim(trebuchet, point) {
  resolveUpdateTrebuchetAim(trebuchet, point, { config: BARRAGE_CONFIG });
}

function beginTrebuchetRelease(trebuchet) {
  resolveBeginTrebuchetRelease(trebuchet, {
    armStateIdle: ARM_STATE_IDLE,
    armStateReleasing: ARM_STATE_RELEASING,
    broadcastSoundEffect,
    config: BARRAGE_CONFIG,
  });
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

function extractConvexPositions(rootTransform) {
  return extractConvexPositionsFromGlb(rootTransform, { childRole, descendantsOf });
}

function registerMeshRoots() {
  loadTargets.clear();
  disposeAllPhysicsAggregates();
  kingConvexPositions.clear();
  gameObjects.clear();

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
      mass: dynamic ? massForObject(transform.name) : 0,
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

    if (isKingName(transform.name)) {
      kingConvexPositions.set(transform.name, extractConvexPositions(transform));
    }
  }

  createPhysicsBodies();

  initialBlockObjects = new Map();
  initialMissileObjects = new Map();
  for (const [id, obj] of gameObjects) {
    if (isBlockName(id)) initialBlockObjects.set(id, { ...obj });
    if (isMissileName(id)) initialMissileObjects.set(id, { ...obj });
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

function resetGameState() {
  dragState.clear();
  impactSoundTicks?.clear();

  // Remove all fragments from the simulation
  for (const [id, object] of [...gameObjects.entries()]) {
    if (!object.isFragment) continue;
    disposePhysicsAggregate(id);
    gameObjects.delete(id);
  }

  // Restore blocks that were fully fragmented (deleted from gameObjects)
  for (const [id, initial] of (initialBlockObjects ?? [])) {
    if (gameObjects.has(id)) continue;
    const restored = {
      ...initial,
      x: initial.originX,
      y: initial.originY,
      z: initial.originZ,
      rot: 0,
      hits: 0,
      pendingFragment: null,
      pendingFragmentHitPosition: null,
      vx: 0, vy: 0, vz: 0,
      angularVelocity: 0,
      dragVx: 0, dragVy: 0, dragVz: 0,
      draggedBy: null,
    };
    gameObjects.set(id, restored);
    const node = new TransformNode(`physics-${id}-restored`, scene);
    node.position.set(restored.x, restored.y, restored.z);
    node.rotationQuaternion = rotationQuaternionForObject(restored);
    const agg = new PhysicsAggregate(node, PhysicsShapeType.BOX, {
      mass: restored.mass,
      friction: restored.friction,
      restitution: restored.restitution,
      center: new Vector3(restored.offsetX, restored.offsetY, restored.offsetZ),
      extents: new Vector3(restored.halfX * 2, restored.halfY * 2, restored.halfZ * 2),
    }, scene);
    agg.body.disablePreStep = true;
    agg.body.setLinearDamping(0.15);
    agg.body.setAngularDamping(angularDampingForObject(restored));
    registerPhysicsAggregate(restored, agg);
    teleportPhysicsBody(agg);
  }

  // Restore missiles that were detonated and deleted from gameObjects
  for (const [id, initial] of (initialMissileObjects ?? [])) {
    if (gameObjects.has(id)) continue;
    const restored = {
      ...initial,
      x: initial.originX,
      y: initial.originY,
      z: initial.originZ,
      rot: 0,
      loadedInto: null,
      pendingBombDetonate: null,
      pendingDispose: undefined,
      usedToFragment: false,
      lastBlockHitTick: null,
      hitBlockIds: new Set(),
      hitFragIds: new Set(),
      hitKingIds: new Set(),
      vx: 0, vy: 0, vz: 0,
      angularVelocity: 0,
      dragVx: 0, dragVy: 0, dragVz: 0,
      draggedBy: null,
    };
    gameObjects.set(id, restored);
    const node = new TransformNode(`physics-${id}-restored`, scene);
    node.position.set(restored.x, restored.y, restored.z);
    node.rotationQuaternion = rotationQuaternionForObject(restored);
    const agg = new PhysicsAggregate(node, PhysicsShapeType.SPHERE, {
      mass: restored.mass,
      friction: restored.friction,
      restitution: restored.restitution,
      center: new Vector3(restored.offsetX, restored.offsetY, restored.offsetZ),
      radius: Math.max(restored.halfX, restored.halfY, restored.halfZ),
    }, scene);
    agg.body.disablePreStep = true;
    agg.body.setLinearDamping(BARRAGE_CONFIG.missileLinearDamping ?? 0.15);
    agg.body.setAngularDamping(angularDampingForObject(restored));
    registerPhysicsAggregate(restored, agg);
    teleportPhysicsBody(agg);
    console.log(`[resetGameState] restored deleted missile ${id} to origin`);
  }

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
    if (object.stretchSoundActive !== undefined) stopTrebuchetStretchSound(object);

    if (object.hits !== undefined) object.hits = 0;
    if (object.pendingFragment !== undefined) object.pendingFragment = null;
    if (object.pendingFragmentHitPosition !== undefined) object.pendingFragmentHitPosition = null;
    if (object.usedToFragment !== undefined) object.usedToFragment = false;
    if (object.lastBlockHitTick !== undefined) object.lastBlockHitTick = null;
    if (object.pendingBombDetonate !== undefined) object.pendingBombDetonate = null;
    if (object.pendingDispose !== undefined) object.pendingDispose = undefined;
    if (object.hitBlockIds !== undefined) object.hitBlockIds = new Set();
    if (object.hitFragIds !== undefined) object.hitFragIds = new Set();
    if (object.hitKingIds !== undefined) object.hitKingIds = new Set();

    syncPhysicsBodyFromObject(object, { x: 0, y: 0, z: 0 });
  }
}

function applyMagneticDragForce(object) {
  resolveApplyMagneticDragForce(object, {
    config: BARRAGE_CONFIG,
    dragState,
    physicsAggregates,
  });
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

    if (object.draggedBy && isMissileName(object.id)) {
      constrainWorldBounds(object);
      syncPhysicsBodyFromObject(object, { x: 0, y: 0, z: 0 });
      continue;
    }

    if (object.draggedBy && usesMagneticDrag(object)) {
      applyMagneticDragForce(object);
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

    syncObjectFromPhysicsBody(object);
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

  await appendServerLevelGlb({ levelFile: level.file, port: PORT, scene: room.scene });
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

wss.on("connection", (socket, req) => {
  const clientId = nextClientId++;
  const sessionId = new URL(req.url, "http://localhost").searchParams.get("sid") ?? null;
  const client = { id: clientId, playerId: null, room: null, socket, sessionId, lastInputAt: Date.now() };
  clients.set(clientId, client);

  let assignmentDone = false;

  function onClientClose() {
    clients.delete(clientId);
    if (!assignmentDone) return; // assignment will clean up when it resolves and sees socket closed

    console.log(`[onClientClose] client=${clientId} playerId=${client.playerId} sessionId=${client.sessionId} hasRoom=${Boolean(client.room)} isMatched=${client.room ? roomManager.isMatched(client.room) : "n/a"} roundWinner=${client.room?.roundWinner ?? "n/a"} matchEnded=${client.room?.matchEnded ?? "n/a"}`);

    let usingGracePeriod = false;
    if (client.room && roomManager.isMatched(client.room) && !client.room.roundWinner && !client.room.matchEnded) {
      bindRoom(client.room);
      const opponentId = opponentPlayerId(client.playerId);
      console.log(`[onClientClose] eligible for grace period, opponentId=${opponentId}`);
      if (opponentId) {
        usingGracePeriod = true;
        const room = client.room;
        const loserPlayerId = client.playerId;
        const sessionId = client.sessionId;
        console.log(`[onClientClose] setting grace period for ${loserPlayerId} sessionId=${sessionId}`);
        const timer = setTimeout(() => {
          console.log(`[onClientClose] grace timer fired for ${loserPlayerId}, pendingReconnect=${JSON.stringify(room.pendingReconnect)}`);
          if (room.pendingReconnect?.sessionId === sessionId) {
            room.pendingReconnect = null;
            endMatchByDisconnect(room, loserPlayerId, opponentId);
          } else {
            console.log(`[onClientClose] grace timer: pendingReconnect sessionId mismatch, not ending match`);
          }
        }, BARRAGE_CONFIG.disconnectGraceMs ?? 2000);
        room.pendingReconnect = { sessionId, playerId: loserPlayerId, timer };
      }
    } else {
      console.log(`[onClientClose] NOT eligible for grace period: hasRoom=${Boolean(client.room)} isMatched=${client.room ? roomManager.isMatched(client.room) : false} roundWinner=${client.room?.roundWinner}`);
    }

    const removal = roomManager.removeClient(client);
    if (!usingGracePeriod && removal?.room) {
      const delay = removal.room.roundWinner ? (BARRAGE_CONFIG.roundEndDelayMs ?? 5000) : 0;
      setTimeout(() => {
        handlePlayerVacancy(removal).catch((error) => {
          console.error("Failed to handle player vacancy.", error);
        });
      }, delay);
    } else if (removal?.spectatorRenames) {
      notifySpectatorRenames(removal.spectatorRenames);
    }
  }

  socket.on("close", onClientClose);

  roomManager.assignClient(client).then(({ room, becameMatched, spectator }) => {
    assignmentDone = true;

    if (socket.readyState !== socket.OPEN) {
      // Socket closed while waiting in the assignment queue — clean up the room/spectator slot
      onClientClose();
      return;
    }

    sendWelcome(client);
    if (spectator) {
      sendLobby(client);
    } else {
      // Track session per slot so we can detect when a genuinely new player fills a slot
      let isForfeitReconnect = false;
      if (client.playerId && client.sessionId) {
        room.playerSessions = room.playerSessions ?? {};
        const prevSession = room.playerSessions[client.playerId];
        if (room.pendingReconnect?.playerId === client.playerId
            && room.pendingReconnect?.sessionId === client.sessionId) {
          // Same session reconnected within grace period — player refreshed, forfeit the round
          clearTimeout(room.pendingReconnect.timer);
          room.pendingReconnect = null;
          if (becameMatched && !room.roundWinner && !room.matchEnded) {
            isForfeitReconnect = true;
          }
        } else if (becameMatched && prevSession && prevSession !== client.sessionId) {
          room.pendingFullReset = true;
        }
        room.playerSessions[client.playerId] = client.sessionId;
      }

      if (isForfeitReconnect) {
        bindRoom(room);
        recordRoundWin(client.playerId, { forfeit: true }); // refreshing player forfeits the round
      } else if (becameMatched) {
        notifyRoomStatus(room).catch((error) => {
          console.error("Failed to notify room status on match.", error);
        });
      } else if (!roomManager.isMatched(room)) {
        sendLobby(client);
      }
    }

    socket.on("message", (raw) => {
      client.lastInputAt = Date.now();
      try {
        if (!client.room || !roomManager.isMatched(client.room)) return;
        bindRoom(client.room);
        applyInput(client, JSON.parse(raw.toString()));
        saveActiveRoomTick();
      } catch (error) {
        sendToClient(client, { type: "error", message: "Invalid message JSON" });
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
      runRoomSimulationTick(room);
    }
  }, TICK_MS);

  const idleTimeoutMs = BARRAGE_CONFIG.idleTimeoutMs ?? 10 * 60 * 1000;
  const inGameIdleTimeoutMs = BARRAGE_CONFIG.inGameIdleTimeoutMs ?? 5 * 60 * 1000;
  setInterval(() => {
    const now = Date.now();
    for (const client of clients.values()) {
      const inGame = client.room && roomManager.isMatched(client.room);
      const timeout = inGame ? inGameIdleTimeoutMs : idleTimeoutMs;
      if (now - client.lastInputAt > timeout) {
        console.log(`Disconnecting idle client ${client.id} (no input for ${timeout / 1000}s, ${inGame ? "in-game" : "lobby"})`);
        if (inGame && !client.room.roundWinner) {
          bindRoom(client.room);
          recordRoundWin(client.id);
        }
        try {
          client.socket.send(JSON.stringify({ type: "idleDisconnect" }));
        } catch { /* ignore */ }
        closeSocket(client.socket);
      }
    }
  }, 30_000);
}

startServer().catch((error) => {
  console.error("Failed to start Barrage server.", error);
  process.exit(1);
});
