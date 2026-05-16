import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { gameObjects, dragState } from "./state.js";
import {
  isTrebuchetName,
  isMissileName,
  isKingName,
  isBlockName,
  isFragmentName,
  constrainWorldBounds,
  constrainedPointForObject,
  normalReleaseVelocityMax,
  releaseVelocityForObject,
} from "./entities.js";
import { clampVector } from "../math.js";
import { TICK_MS, getConfig } from "../config.js";
import {
  physicsAggregates,
  syncPhysicsBodyFromObject,
  setPhysicsBodyTrigger,
  returnDraggedObjectUpright,
} from "./physics.js";
import { maybeLoadMissile } from "./trebuchet.js";

export function usesMagneticDrag(object) {
  if (isFragmentName(object.id)) return false;
  return isBlockName(object.id) || isTrebuchetName(object.id);
}

function localPointForObject(object, point) {
  const aggregate = physicsAggregates.get(object.id);
  if (!aggregate) return { x: 0, y: 0, z: 0 };

  const node = aggregate.transformNode;
  node.computeWorldMatrix(true);
  const inverse = node.getWorldMatrix().clone().invert();
  const local = Vector3.TransformCoordinates(
    new Vector3(Number(point.x), Number(point.y ?? object.y), Number(point.z)),
    inverse,
  );
  return { x: local.x, y: local.y, z: local.z };
}

function validateDragPosition(point, previousPoint, dt) {
  const cappedDt = Math.min(dt, 2 * TICK_MS / 1000);
  const dx = Number(point.x) - Number(previousPoint.x);
  const dy = Number(point.y ?? previousPoint.y) - Number(previousPoint.y);
  const dz = Number(point.z) - Number(previousPoint.z);
  const distance = Math.hypot(dx, dy, dz);
  const maxDistance = getConfig("maxDragSpeed") * cappedDt;

  if (distance <= maxDistance) {
    return {
      x: Number(point.x),
      y: Number(point.y ?? previousPoint.y),
      z: Number(point.z),
    };
  }

  const scale = maxDistance / distance;
  return {
    x: Number(previousPoint.x) + dx * scale,
    y: Number(previousPoint.y) + dy * scale,
    z: Number(previousPoint.z) + dz * scale,
  };
}

export function applyMagneticDragForce(object) {
  const aggregate = physicsAggregates.get(object.id);
  if (!aggregate) return;

  const state = dragState.get(object.id);
  if (!state?.grabLocalPoint || !state.lastPoint) return;

  const node = aggregate.transformNode;
  node.computeWorldMatrix(true);

  const grabWorldPoint = Vector3.TransformCoordinates(
    new Vector3(state.grabLocalPoint.x, state.grabLocalPoint.y, state.grabLocalPoint.z),
    node.getWorldMatrix(),
  );

  const targetPoint = new Vector3(
    Number(state.lastPoint.x),
    Number(state.lastPoint.y),
    Number(state.lastPoint.z),
  );

  const displacement = targetPoint.subtract(grabWorldPoint);
  const distance = displacement.length();
  if (distance < 0.0001 || distance > getConfig("dragRadiusLimit")) return;

  const forceDirection = displacement.normalize();
  const magneticForce = forceDirection.scale(getConfig("dragForceMax"));

  const linearVelocity = aggregate.body.getLinearVelocity();
  const angularVelocity = aggregate.body.getAngularVelocity();
  const centerOfMass = node.position.add(
    new Vector3(object.offsetX ?? 0, object.offsetY ?? 0, object.offsetZ ?? 0),
  );
  const r = grabWorldPoint.subtract(centerOfMass);
  const pointVelocity = linearVelocity.add(Vector3.Cross(angularVelocity, r));
  const dampingForce = pointVelocity.scale(-getConfig("dragDampingMax"));

  const totalForce = magneticForce.add(dampingForce);
  totalForce.z = 0;
  if (isTrebuchetName(object.id)) totalForce.y = 0;

  aggregate.body.applyForce(totalForce, grabWorldPoint);
}

function moveMissileReleaseUntilClear(object, clientId) {
  const step = getConfig("depenetrationStep");
  const maxDist = getConfig("depenetrationMaxDistance");

  function overlapsAny(x, y, z) {
    for (const other of gameObjects.values()) {
      if (other.id === object.id) continue;
      if (isFragmentName(other.id)) continue;
      if (!physicsAggregates.has(other.id)) continue;

      const dx = Math.abs(x - other.x) - (object.halfX + other.halfX);
      const dy = Math.abs(y - other.y) - (object.halfY + other.halfY);
      const dz = Math.abs(z - other.z) - (object.halfZ + other.halfZ);
      if (dx < 0 && dy < 0 && dz < 0) return true;
    }
    return false;
  }

  if (!overlapsAny(object.x, object.y, object.z)) return;

  for (let d = step; d <= maxDist; d += step) {
    if (!overlapsAny(object.x, object.y + d, object.z)) {
      object.y += d;
      return;
    }
  }

  const xDir = clientId === 1 ? -1 : 1;
  for (let d = step; d <= maxDist; d += step) {
    if (!overlapsAny(object.x + d * xDir, object.y, object.z)) {
      object.x += d * xDir;
      return;
    }
  }
}

export function releaseDragForClient(clientId) {
  for (const object of gameObjects.values()) {
    if (object.draggedBy !== clientId) continue;

    const state = dragState.get(object.id);

    if (usesMagneticDrag(object) && state?.originalAngularDamping !== undefined) {
      const aggregate = physicsAggregates.get(object.id);
      if (aggregate) {
        aggregate.body.setAngularDamping(state.originalAngularDamping);
      }
    }

    if (isMissileName(object.id)) {
      setPhysicsBodyTrigger(object, false);
    }

    object.dragVx = 0;
    object.dragVy = 0;
    object.dragVz = 0;
    object.draggedBy = null;
    dragState.delete(object.id);
  }
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

export function handleDragStart(client, message) {
  const object = gameObjects.get(message.entityId);
  if (!object || !message.point) return;
  if (!object.dynamic) return;
  if (object.loadedInto) return;
  if (isKingName(object.id)) return;
  if (object.draggedBy) return;

  if (isTrebuchetName(object.id)) {
    if (object.player && object.player !== client.id) return;
  } else {
    if (client.id === 1 && object.x > 2) return;
    if (client.id === 2 && object.x < -2) return;
  }

  object.draggedBy = client.id;
  object.vx = 0;
  object.vy = 0;
  object.vz = 0;

  if (usesMagneticDrag(object)) {
    const aggregate = physicsAggregates.get(object.id);
    if (aggregate) {
      aggregate.body.setLinearVelocity(Vector3.Zero());
      aggregate.body.setAngularVelocity(Vector3.Zero());
    }
    const grabLocalPoint = localPointForObject(object, message.point);
    const originalAngularDamping = aggregate?.body.getAngularDamping() ?? 0;
    if (aggregate) aggregate.body.setAngularDamping(0);
    dragState.set(object.id, {
      lastTime: Date.now(),
      lastPoint: message.point,
      grabLocalPoint,
      originalAngularDamping,
    });
  } else {
    if (isMissileName(object.id)) setPhysicsBodyTrigger(object, true);
    returnDraggedObjectUpright(object);
    dragState.set(object.id, { lastTime: Date.now(), lastPoint: message.point });
  }
}

export function handleDragMove(client, message) {
  const object = gameObjects.get(message.entityId);
  if (!object || !message.point) return;
  if (object.draggedBy !== client.id) return;

  const now = Date.now();
  const previous = dragState.get(object.id);
  const dt = Math.max(0.001, (now - (previous?.lastTime ?? now)) / 1000);

  const validated = validateDragPosition(message.point, previous?.lastPoint ?? message.point, dt);
  const next = constrainedPointForObject(object, validated, client.id);

  if (usesMagneticDrag(object)) {
    dragState.set(object.id, {
      ...previous,
      lastTime: now,
      lastPoint: next,
    });
    return;
  }

  object.dragVx = (next.x - object.x) / dt;
  object.dragVy = (next.y - object.y) / dt;
  object.dragVz = (next.z - object.z) / dt;
  object.x = next.x;
  object.y = next.y;
  object.z = next.z;
  constrainWorldBounds(object);
  returnDraggedObjectUpright(object);
  syncPhysicsBodyFromObject(object, { x: 0, y: 0, z: 0 });
  object.vx = 0;
  object.vy = 0;
  object.vz = 0;
  dragState.set(object.id, { lastTime: now, lastPoint: next });
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
