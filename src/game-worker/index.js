// Authoritative game simulation running as a browser Web Worker.
// Ported from server.js — replaces Node.js I/O with postMessage.
//
// Main → Worker:
//   { type: "init", serverBaseUrl }
//   { type: "playerConnect", role }           "host" | "guest"
//   { type: "playerMessage", role, data }     stringified JSON (same protocol as WebSocket)
//   { type: "playerDisconnect", role }
//
// Worker → Main:
//   { type: "toPlayer", role, data }          stringified JSON
//   { type: "ready" }
//   { type: "error", message }

// Babylon.js shader compilation paths check for `document` even in NullEngine.
// Stub it out so those code paths fail silently instead of spamming the console.
if (typeof document === "undefined") {
  globalThis.document = {
    createElement: () => ({ getContext: () => null, style: {}, setAttribute() {}, addEventListener() {}, removeEventListener() {} }),
    createElementNS: () => ({}),
    getElementById: () => null,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
  };
}

import HavokPhysics from "@babylonjs/havok";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin.js";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate.js";
import { PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin.js";
import "@babylonjs/core/Physics/v2/physicsEngineComponent.js";
import { SERVER_CONFIG } from "../../config/server.js";
import { BARRAGE_CONFIG } from "../../public/config.js";
import { firstLevel, nextLevel } from "../../server/levelCatalog.js";
import { playerSide, canGrab, isInPlayerZone, zoneLimitX, checkKingKnockout, isMatchWin } from "../../server/gameManager.js";
import { createFragmentSystem } from "../../server/fragments.js";
import { createInputHandler } from "../../server/input.js";
import { createPhysicsBodySystem } from "../../server/physics-bodies.js";
import {
  createRoomRuntime,
  createRoomState as createRoomStateFromInfo,
  resetRoomProgress as resetRoomProgressState,
} from "../../server/room-state.js";
import {
  applyMagneticDragForce as resolveApplyMagneticDragForce,
  constrainedPointForObject as resolveConstrainedPointForObject,
  constrainWorldBounds as resolveConstrainWorldBounds,
  localPointForObject as resolveLocalPointForObject,
  moveMissileReleaseTowardOriginUntilClear as resolveMoveMissileReleaseTowardOriginUntilClear,
  usableReleaseVelocity as resolveUsableReleaseVelocity,
  usesMagneticDrag,
} from "../../server/drag.js";
import {
  beginTrebuchetRelease as resolveBeginTrebuchetRelease,
  loadTargetForTrebuchet as resolveLoadTargetForTrebuchet,
  maybeLoadMissile as resolveMaybeLoadMissile,
  updateTrebuchetAim as resolveUpdateTrebuchetAim,
} from "../../server/trebuchet.js";
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
} from "../../server/utils.js";
import {
  createPhysicsContactRecorder,
  handlePhysicsContacts as handleCollisionContacts,
} from "../../server/collision-events.js";
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
} from "../../server/glb-parser.js";
import { createSimulationRunner } from "../../server/simulation.js";
import {
  createSoundEventDispatcher,
  impactPositionFor,
  impactSpeedFor,
} from "../../server/server-events.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TICK_RATE = 60;
const TICK_MS = 1000 / TICK_RATE;

const ARM_STATE_IDLE = "idle";
const ARM_STATE_AIMING = "aiming";
const ARM_STATE_RELEASING = "releasing";
const ARM_STATE_RETURNING = "returning";

const HOST_PLAYER_ID = "Player_1";
const GUEST_PLAYER_ID = "Player_2";

const ROOM_INFO = {
  id: "worker-room",
  index: 0,
  playerIds: [HOST_PLAYER_ID, GUEST_PLAYER_ID],
};

// ---------------------------------------------------------------------------
// Worker I/O — replaces WebSocket
// ---------------------------------------------------------------------------

const connectedRoles = new Set(); // "host" | "guest"
const playerUsernames = {}; // role → display username

function sendToRole(role, msg) {
  if (!connectedRoles.has(role)) return;
  console.log(`[worker] sendToRole ${role}:`, msg.type);
  self.postMessage({ type: "toPlayer", role, data: JSON.stringify(msg) });
}

function playerIdForRole(role) {
  return role === "host" ? HOST_PLAYER_ID : GUEST_PLAYER_ID;
}

function roleForPlayerId(playerId) {
  return playerId === HOST_PLAYER_ID ? "host" : "guest";
}

// ---------------------------------------------------------------------------
// Module-level game state (mirrors server.js globals)
// ---------------------------------------------------------------------------

let serverBaseUrl = "";
let activeRoom = null;
let engine = null;
let scene = null;
let tick = 0;
let gameObjects = null;
let dragState = null;
let loadTargets = null;
let physicsAggregates = null;
let physicsCollisionObservers = null;
let physicsContactEvents = null;
let impactSoundTicks = null;
let initialBlockObjects = null;
let initialMissileObjects = null;
let kingConvexPositions = new Map();
let simulationInterval = null;
let havokInterfacePromise = null;

const recordPhysicsContactEvent = createPhysicsContactRecorder({
  getPhysicsContactEvents: () => physicsContactEvents,
  getTick: () => tick,
});

// ---------------------------------------------------------------------------
// Room binding (same pattern as server.js)
// ---------------------------------------------------------------------------

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
  if (activeRoom) activeRoom.tick = tick;
}

function resetRoomProgress(room) {
  resetRoomProgressState(room, { firstLevel });
}

// ---------------------------------------------------------------------------
// Broadcast / send — replaces WebSocket broadcasts
// ---------------------------------------------------------------------------

function broadcast(msg) {
  if (!activeRoom) return;
  for (const role of connectedRoles) {
    self.postMessage({ type: "toPlayer", role, data: JSON.stringify(msg) });
  }
}

// ---------------------------------------------------------------------------
// Sound / network messenger stubs
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Physics body system
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Fragment system
// ---------------------------------------------------------------------------

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  return res.arrayBuffer();
}

const {
  fragmentBlock,
  loadFragmentTemplates,
  maybeRecordBlockHit,
  maybeRecordFragmentHit,
  processBombDetonations,
  updateFragmentColliderShrinks,
} = createFragmentSystem({
  assetsDir: { toString() { return `${serverBaseUrl}/assets`; } },
  broadcast,
  broadcastImpactSoundEffect,
  config: BARRAGE_CONFIG,
  disposePhysicsAggregate,
  fetchBuffer: (file) => fetchBuffer(file),
  gameObjects: () => gameObjects,
  getActiveRoom: () => activeRoom,
  getScene: () => scene,
  getTick: () => tick,
  isKingName,
  onBombKingKill: recordBombKingKill,
  physicsAggregates: () => physicsAggregates,
  parseFragmentGlb: (buffer) => parseFragmentGlbData(buffer, { childRole }),
  registerPhysicsAggregate,
  serverConfig: SERVER_CONFIG,
  teleportPhysicsBody,
  tickMs: TICK_MS,
});

// ---------------------------------------------------------------------------
// Simulation runner
// ---------------------------------------------------------------------------

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
  incrementTick: () => { tick += 1; return tick; },
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

// ---------------------------------------------------------------------------
// Helper functions (same as server.js)
// ---------------------------------------------------------------------------

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
  return activeRoom.playerIds.find((id) => id !== playerId) ?? null;
}

function sendState() {
  const msg = {
    type: "state",
    roomId: activeRoom.id,
    tick,
    serverTime: Date.now(),
    level: activeRoom.level.url,
    roundNumber: activeRoom.roundNumber,
    scores: activeRoom.scores,
    objects: [...gameObjects.values()].map(toWireObject),
  };
  broadcast(msg);
}

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

// ---------------------------------------------------------------------------
// Input handler
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Physics simulation (copied verbatim from server.js)
// ---------------------------------------------------------------------------

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
      const restAngle = restArmAngleForTrebuchet(trebuchet);
      trebuchet.armAngle = lerp(startArmAngle, restAngle, progress);
      if (progress >= 1) {
        trebuchet.armAngle = restAngle;
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
    const restAngle = restArmAngleForTrebuchet(trebuchet);
    const previousArmAngle = trebuchet.armAngle ?? startArmAngle;
    const velocity = trebuchet.pendingShot?.velocity ?? { x: 0, y: 0, z: 0 };
    trebuchet.armAngle = lerp(startArmAngle, 0, progress);

    const shouldReleaseAtRest = !trebuchet.pendingShot?.released
      && (startArmAngle <= restAngle || (previousArmAngle > restAngle && trebuchet.armAngle <= restAngle));

    if (shouldReleaseAtRest) {
      releaseLoadedMissileFromTrebuchet(trebuchet, velocity, restAngle);
      if (trebuchet.pendingShot) trebuchet.pendingShot.released = true;
    }

    if (progress < 1) continue;

    if (!trebuchet.pendingShot?.released) {
      releaseLoadedMissileFromTrebuchet(trebuchet, velocity, restAngle);
    }
    trebuchet.fireState = ARM_STATE_RETURNING;
    trebuchet.pendingShot = null;
    trebuchet.returnStartArmAngle = trebuchet.armAngle;
    trebuchet.releaseElapsedMs = 0;
  }
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
    ...scene.transformNodes.filter((t) => !t.parent || t.parent.name === "__root__"),
    ...scene.meshes.filter((m) => !m.parent || m.parent.name === "__root__"),
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
      x: position.x, y: position.y, z: position.z,
      originX: position.x, originY: position.y, originZ: position.z,
      rot: 0, angularVelocity: 0,
      vx: 0, vy: 0, vz: 0,
      dragVx: 0, dragVy: 0, dragVz: 0,
      dynamic,
      draggedBy: null,
      offsetX: bounds.offsetX, offsetY: bounds.offsetY, offsetZ: bounds.offsetZ,
      halfX: bounds.halfX, halfY: bounds.halfY, halfZ: bounds.halfZ,
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
    events: [{ kind: "kingHit", kingId: king.id, playerId: loser, hits: king.hits, maxHits: king.maxHits ?? 3 }],
  });

  if (king.hits >= (king.maxHits ?? 3)) {
    recordRoundWin(loser);
  }
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
    events: [{ kind: "kingHit", kingId: king.id, playerId: loser, hits: king.maxHits ?? 3, maxHits: king.maxHits ?? 3 }],
  });
  recordRoundWin(loser);
}

// ---------------------------------------------------------------------------
// Round / match lifecycle
// ---------------------------------------------------------------------------

function recordRoundWin(loserPlayerId) {
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
  });

  if (matchWin) {
    const delay = BARRAGE_CONFIG.matchEndDelayMs ?? 14000;
    setTimeout(() => {
      broadcast({ type: "matchOver" });
      stopSimulation();
    }, delay);
  } else {
    const delay = BARRAGE_CONFIG.roundEndDelayMs ?? 5000;
    setTimeout(() => {
      advanceRoomAfterRound(room).catch((err) => console.error("advanceRoom failed:", err));
    }, delay);
  }
}

async function advanceRoomAfterRound(room) {
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

  const forfeitLoser = room.pendingForfeitLoser ?? null;
  room.pendingForfeitLoser = null;
  broadcast({
    type: "levelChanged",
    roomId: room.id,
    level: room.level.url,
    roundNumber: room.roundNumber,
    scores: room.scores,
    ...(forfeitLoser && { forfeitLoser }),
  });
  sendState();
}

async function reloadRoom() {
  if (!activeRoom) return;
  activeRoom.paused = true;
  activeRoom.roundWinner = null;
  createRoomRuntime(activeRoom);
  bindRoom(activeRoom);
  await enableHavokPhysics();
  await loadLevelIfPresent();
  await loadFragmentTemplates();
  activeRoom.paused = false;
  saveActiveRoomTick();
  broadcast({
    type: "levelChanged",
    roomId: activeRoom.id,
    level: activeRoom.level.url,
    roundNumber: activeRoom.roundNumber,
    scores: activeRoom.scores,
    forceReload: true,
  });
  sendState();
}

function resetGameState() {
  dragState.clear();
  impactSoundTicks?.clear();

  for (const [id, object] of [...gameObjects.entries()]) {
    if (!object.isFragment) continue;
    disposePhysicsAggregate(id);
    gameObjects.delete(id);
  }

  for (const [id, initial] of (initialBlockObjects ?? [])) {
    if (gameObjects.has(id)) continue;
    const restored = {
      ...initial,
      x: initial.originX, y: initial.originY, z: initial.originZ,
      rot: 0, hits: 0, pendingFragment: null, pendingFragmentHitPosition: null,
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
      mass: restored.mass, friction: restored.friction, restitution: restored.restitution,
      center: new Vector3(restored.offsetX, restored.offsetY, restored.offsetZ),
      extents: new Vector3(restored.halfX * 2, restored.halfY * 2, restored.halfZ * 2),
    }, scene);
    agg.body.disablePreStep = true;
    agg.body.setLinearDamping(0.15);
    agg.body.setAngularDamping(angularDampingForObject(restored));
    registerPhysicsAggregate(restored, agg);
    teleportPhysicsBody(agg);
  }

  for (const [id, initial] of (initialMissileObjects ?? [])) {
    if (gameObjects.has(id)) continue;
    const restored = {
      ...initial,
      x: initial.originX, y: initial.originY, z: initial.originZ,
      rot: 0, loadedInto: null, pendingBombDetonate: null, pendingDispose: undefined,
      usedToFragment: false, lastBlockHitTick: null,
      hitBlockIds: new Set(), hitFragIds: new Set(), hitKingIds: new Set(),
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
      mass: restored.mass, friction: restored.friction, restitution: restored.restitution,
      center: new Vector3(restored.offsetX, restored.offsetY, restored.offsetZ),
      radius: Math.max(restored.halfX, restored.halfY, restored.halfZ),
    }, scene);
    agg.body.disablePreStep = true;
    agg.body.setLinearDamping(BARRAGE_CONFIG.missileLinearDamping ?? 0.15);
    agg.body.setAngularDamping(angularDampingForObject(restored));
    registerPhysicsAggregate(restored, agg);
    teleportPhysicsBody(agg);
  }

  for (const object of gameObjects.values()) {
    object.x = object.originX; object.y = object.originY; object.z = object.originZ;
    object.rot = 0; object.angularVelocity = 0;
    object.vx = 0; object.vy = 0; object.vz = 0;
    object.dragVx = 0; object.dragVy = 0; object.dragVz = 0;
    object.draggedBy = null;

    if (object.loaded !== undefined) object.loaded = false;
    if (object.loadedInto !== undefined) { object.loadedInto = null; setPhysicsBodyTrigger(object, false); }
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

// ---------------------------------------------------------------------------
// Physics / level setup
// ---------------------------------------------------------------------------

async function enableHavokPhysics() {
  const room = activeRoom;
  // In browser, HavokPhysics() auto-fetches WASM — no fs.readFile needed
  havokInterfacePromise ??= HavokPhysics();
  const havokInterface = await havokInterfacePromise;
  bindRoom(room);
  const havokPlugin = new HavokPlugin(true, havokInterface);
  scene.enablePhysics(new Vector3(0, SERVER_CONFIG.gravity, 0), havokPlugin);
}

async function loadLevelIfPresent() {
  const room = activeRoom;
  const level = room.level;
  try {
    await appendServerLevelGlb({
      levelFile: level.file,
      baseUrl: `${serverBaseUrl}/assets/`,
      scene: room.scene,
    });
  } catch (err) {
    console.warn(`Could not load ${level.file}: ${err.message}`);
    return;
  }
  bindRoom(room);
  applyTrebuchetArmRestPose();
  registerMeshRoots();
  console.log(`[worker] Loaded ${level.file} with ${gameObjects.size} game objects.`);
}

// ---------------------------------------------------------------------------
// Simulation loop
// ---------------------------------------------------------------------------

function startSimulation() {
  if (simulationInterval) return;
  _startLatencyProbe();
  simulationInterval = setInterval(() => {
    if (!activeRoom) return;
    _flushHostInputQueue();
    runRoomSimulationTick(activeRoom);
  }, TICK_MS);
}

function stopSimulation() {
  if (simulationInterval) {
    clearInterval(simulationInterval);
    simulationInterval = null;
  }
}

// ---------------------------------------------------------------------------
// Lag compensation — host input is delayed by half the P1↔P2 RTT
// ---------------------------------------------------------------------------

let _halfRtt = 0;
let _hostInputQueue = []; // { applyAt, client, msg }

function _startLatencyProbe() {
  setInterval(() => {
    if (!connectedRoles.has("guest")) return;
    sendToRole("guest", { type: "ping", ts: Date.now() });
  }, 2000);
}

function _handlePong(ts) {
  const rtt = Date.now() - ts;
  _halfRtt = Math.max(0, Math.min(rtt / 2, 200)); // cap at 200ms
}

function _flushHostInputQueue() {
  const now = Date.now();
  const ready = _hostInputQueue.filter((e) => e.applyAt <= now);
  _hostInputQueue = _hostInputQueue.filter((e) => e.applyAt > now);
  for (const { client, msg } of ready) {
    applyInput(client, msg);
  }
}

// ---------------------------------------------------------------------------
// Player connection lifecycle
// ---------------------------------------------------------------------------

async function handlePlayerConnect(role, username) {
  console.log(`[worker] handlePlayerConnect(${role}), connectedRoles=`, [...connectedRoles]);
  connectedRoles.add(role);
  if (username) playerUsernames[role] = username;
  const playerId = playerIdForRole(role);

  // Send welcome
  sendToRole(role, {
    type: "welcome",
    clientId: role === "host" ? 1 : 2,
    playerId,
    displayName: playerUsernames[role] ?? playerId,
    tickRate: TICK_RATE,
  });

  const bothConnected = connectedRoles.has("host") && connectedRoles.has("guest");
  if (!bothConnected) {
    // Still waiting — send lobby status
    sendToRole(role, {
      type: "lobby",
      roomId: activeRoom.id,
      playerId,
      status: "waiting",
      level: activeRoom.level.url,
    });
    return;
  }

  // Both players connected — start the game
  console.log("[worker] both connected — initializing room...");
  activeRoom.paused = true;
  createRoomRuntime(activeRoom);
  bindRoom(activeRoom);

  try {
    console.log("[worker] enableHavokPhysics...");
    await enableHavokPhysics();
    console.log("[worker] loadLevelIfPresent...");
    await loadLevelIfPresent();
    console.log("[worker] loadFragmentTemplates...");
    await loadFragmentTemplates();
    console.log("[worker] room init complete");
  } catch (err) {
    console.error("[worker] room init failed:", err);
    self.postMessage({ type: "error", message: `Room init failed: ${err.message}` });
    return;
  }

  activeRoom.paused = false;
  saveActiveRoomTick();

  // Send matched to both players
  for (const r of ["host", "guest"]) {
    const pid = playerIdForRole(r);
    const oppRole = r === "host" ? "guest" : "host";
    const opponentPid = playerIdForRole(oppRole);
    sendToRole(r, {
      type: "matched",
      roomId: activeRoom.id,
      playerId: pid,
      opponentId: opponentPid,
      displayName: playerUsernames[r] ?? pid,
      opponentDisplayName: playerUsernames[oppRole] ?? opponentPid,
      level: activeRoom.level.url,
      roundNumber: activeRoom.roundNumber,
      scores: activeRoom.scores,
    });
  }

  startSimulation();
}

function handlePlayerDisconnect(role) {
  connectedRoles.delete(role);
  stopSimulation();

  const loserPlayerId = playerIdForRole(role);
  const winnerRole = role === "host" ? "guest" : "host";
  const winnerPlayerId = playerIdForRole(winnerRole);

  if (connectedRoles.has(winnerRole) && activeRoom && !activeRoom.matchEnded) {
    activeRoom.matchEnded = true;
    broadcast({
      type: "roundEnded",
      roomId: activeRoom.id,
      tick,
      winner: winnerPlayerId,
      loser: loserPlayerId,
      roundNumber: activeRoom?.roundNumber ?? 1,
      scores: activeRoom?.scores ?? {},
      matchWon: true,
    });
    setTimeout(() => {
      broadcast({ type: "matchOver" });
    }, BARRAGE_CONFIG.matchEndDelayMs ?? 4000);
  }
}

function handleSurrenderBattle(role) {
  if (!activeRoom || activeRoom.roundWinner) return;
  const loserPlayerId = playerIdForRole(role);
  activeRoom.pendingForfeitLoser = loserPlayerId;
  recordRoundWin(loserPlayerId);
}

function handleSurrenderWar(role) {
  if (!activeRoom || activeRoom.matchEnded) return;
  const loserPlayerId = playerIdForRole(role);
  const winnerRole = role === "host" ? "guest" : "host";
  const winnerPlayerId = playerIdForRole(winnerRole);
  activeRoom.matchEnded = true;
  stopSimulation();
  broadcast({
    type: "roundEnded",
    roomId: activeRoom.id,
    tick,
    winner: winnerPlayerId,
    loser: loserPlayerId,
    roundNumber: activeRoom?.roundNumber ?? 1,
    scores: activeRoom?.scores ?? {},
    matchWon: true,
  });
  setTimeout(() => {
    broadcast({ type: "matchOver" });
  }, BARRAGE_CONFIG.matchEndDelayMs ?? 4000);
}

function handlePlayerMessage(role, msg) {
  try {
    if (!activeRoom || !connectedRoles.has("host") || !connectedRoles.has("guest")) return;
    const parsed = typeof msg === "string" ? JSON.parse(msg) : msg;

    // Pong from guest — update half-RTT measurement
    if (parsed.type === "pong") {
      _handlePong(parsed.ts);
      return;
    }

    // Surrender
    if (parsed.type === "input" && parsed.action === "surrender") {
      if (parsed.surrenderType === "war") {
        handleSurrenderWar(role);
      } else {
        handleSurrenderBattle(role);
      }
      return;
    }

    bindRoom(activeRoom);
    const client = { playerId: playerIdForRole(role), room: activeRoom };

    if (role === "host" && _halfRtt > 8) {
      // Delay host inputs by halfRtt so both players' actions arrive ~simultaneously
      _hostInputQueue.push({ applyAt: Date.now() + _halfRtt, client, msg: parsed });
    } else {
      applyInput(client, parsed);
    }
    saveActiveRoomTick();
  } catch (err) {
    console.error("[worker] handlePlayerMessage error:", err);
  }
}

// ---------------------------------------------------------------------------
// Initialise worker
// ---------------------------------------------------------------------------

async function initWorker(baseUrl) {
  serverBaseUrl = baseUrl.replace(/\/$/, "");

  // Pre-create the room (no players yet)
  activeRoom = createRoomStateFromInfo({ roomInfo: ROOM_INFO, firstLevel });
  activeRoom.matchEnded = false;
  bindRoom(activeRoom);

  self.postMessage({ type: "ready" });
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

self.onmessage = ({ data }) => {
  switch (data.type) {
    case "init":
      initWorker(data.serverBaseUrl).catch((err) => {
        self.postMessage({ type: "error", message: err.message });
      });
      break;

    case "setUsername":
      playerUsernames[data.role] = data.username;
      break;

    case "playerConnect":
      handlePlayerConnect(data.role, data.username).catch((err) => {
        self.postMessage({ type: "error", message: err.message });
      });
      break;

    case "playerMessage":
      handlePlayerMessage(data.role, data.data);
      break;

    case "playerDisconnect":
      handlePlayerDisconnect(data.role);
      break;

    default:
      console.warn("[worker] Unknown message type:", data.type);
  }
};
