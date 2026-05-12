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

  if (isTrebuchetName(object.id)) {
    if (object.player && object.player !== client.id) return;
  } else {
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
