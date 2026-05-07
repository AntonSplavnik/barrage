import { gameObjects, dragState } from "./state.js";
import { BARRAGE_CONFIG } from "../public/config.js";
import {
  isTrebuchetName,
  isMissileName,
  clampVector,
  constrainWorldBounds,
  constrainedPointForObject,
  normalReleaseVelocityMax,
  releaseVelocityForObject,
  restArmAngleForTrebuchet,
  ARM_STATE_IDLE,
  ARM_STATE_AIMING,
  ARM_STATE_RELEASING,
} from "./utils.js";
import {
  syncPhysicsBodyFromObject,
  setPhysicsBodyTrigger,
  returnDraggedObjectUpright,
} from "./physics.js";
import { maybeLoadMissile, updateTrebuchetAim, beginTrebuchetRelease } from "./trebuchet.js";
import { broadcast } from "./network.js";

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

export function applyInput(client, message) {
  if (message.type !== "input") return;

  if (message.action === "reset") {
    resetGameState();
    broadcast({
      type: "event",
      tick: 0,
      events: [{ kind: "reset", playerId: client.playerId }],
    });
    return;
  }

  if (message.action === "dragStart") {
    const object = gameObjects.get(message.entityId);
    if (!object || !message.point) return;
    if (!object.dynamic) return;
    if (object.loadedInto) return;

    if (!isTrebuchetName(object.id)) {
      if (client.id === 1 && object.x > 0) return;
      if (client.id === 2 && object.x < 0) return;
    }

    object.draggedBy = client.id;
    if (isMissileName(object.id)) setPhysicsBodyTrigger(object, true);
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

  if (message.action === "dragMove") {
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

  if (message.action === "dragEnd") {
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

  if (message.action === "fire") {
    broadcast({
      type: "event",
      tick: 0,
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
