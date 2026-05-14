import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import {
  clamp,
  clampVector,
  isBlockName,
  isLeftSideTrebuchetName,
  isMissileName,
  isTrebuchetName,
  normalReleaseVelocityMax,
  releaseVelocityForObject,
} from "./utils.js";

export function usesMagneticDrag(object) {
  return isBlockName(object.id) || isTrebuchetName(object.id);
}

export function localPointForObject(object, point, { physicsAggregates }) {
  const aggregate = physicsAggregates.get(object.id);
  if (!aggregate) return null;

  aggregate.transformNode.computeWorldMatrix(true);
  const local = Vector3.TransformCoordinates(
    new Vector3(Number(point.x), Number(point.y ?? object.y), Number(point.z)),
    aggregate.transformNode.getWorldMatrix().clone().invert(),
  );

  return {
    x: local.x,
    y: local.y,
    z: local.z,
  };
}

export function constrainWorldBounds(object, { serverConfig }) {
  object.x = clamp(object.x, serverConfig.worldMinX, serverConfig.worldMaxX);
  if (typeof serverConfig.worldMinY === "number") {
    object.y = Math.max(serverConfig.worldMinY, object.y);
  }
  object.z = clamp(object.z, serverConfig.worldMinZ, serverConfig.worldMaxZ);

  if (object.x === serverConfig.worldMinX && object.vx < 0) object.vx = 0;
  if (object.x === serverConfig.worldMaxX && object.vx > 0) object.vx = 0;
  if (object.y === serverConfig.worldMinY && object.vy < 0) object.vy = 0;
  if (object.z === serverConfig.worldMinZ && object.vz < 0) object.vz = 0;
  if (object.z === serverConfig.worldMaxZ && object.vz > 0) object.vz = 0;
}

export function velocityFromDragState(object, point, { dragState, now = Date.now() }) {
  const previous = dragState.get(object.id);
  if (!previous?.lastPoint || !previous.lastTime) return { x: 0, y: 0, z: 0 };

  const dt = Math.max(0.001, (now - previous.lastTime) / 1000);
  return clampVector({
    x: (Number(point.x) - Number(previous.lastPoint.x)) / dt,
    y: (Number(point.y ?? object.y) - Number(previous.lastPoint.y ?? object.y)) / dt,
    z: (Number(point.z) - Number(previous.lastPoint.z)) / dt,
  }, normalReleaseVelocityMax());
}

export function usableReleaseVelocity(object, message, { dragState }) {
  if (isMissileName(object.id)) {
    return releaseVelocityForObject(object, velocityFromDragState(object, message.point, { dragState }));
  }

  const clientVelocity = releaseVelocityForObject(object, message.velocity);
  const clientSpeed = Math.hypot(clientVelocity.x, clientVelocity.y, clientVelocity.z);

  if (clientSpeed > 0.1) {
    return clientVelocity;
  }

  return releaseVelocityForObject(object, velocityFromDragState(object, message.point, { dragState }));
}

export function constrainedPointForObject(object, point, { config, serverConfig = {} }) {
  if (!isTrebuchetName(object.id)) {
    const y = Number(point.y ?? object.y);
    const minY = Math.max(
      typeof serverConfig.worldMinY === "number" ? serverConfig.worldMinY : -Infinity,
      isMissileName(object.id) && typeof serverConfig.worldMinY === "number"
        ? serverConfig.worldMinY + (config.missileReleaseFloorPadding ?? 0.05)
        : -Infinity,
    );
    return {
      x: Number(point.x),
      y: Math.max(minY, y),
      z: Number(point.z),
    };
  }

  const minX = isLeftSideTrebuchetName(object.id)
    ? config.trebuchetLeftMinX
    : config.trebuchetRightMinX;
  const maxX = isLeftSideTrebuchetName(object.id)
    ? config.trebuchetLeftMaxX
    : config.trebuchetRightMaxX;

  return {
    x: clamp(Number(point.x), minX, maxX),
    y: object.originY,
    z: object.originZ,
  };
}

function objectBoundsAt(object, position = object) {
  return {
    minX: Number(position.x) + Number(object.offsetX ?? 0) - Number(object.halfX ?? 0),
    maxX: Number(position.x) + Number(object.offsetX ?? 0) + Number(object.halfX ?? 0),
    minY: Number(position.y) + Number(object.offsetY ?? 0) - Number(object.halfY ?? object.halfHeight ?? 0),
    maxY: Number(position.y) + Number(object.offsetY ?? 0) + Number(object.halfY ?? object.halfHeight ?? 0),
    minZ: Number(position.z) + Number(object.offsetZ ?? 0) - Number(object.halfZ ?? 0),
    maxZ: Number(position.z) + Number(object.offsetZ ?? 0) + Number(object.halfZ ?? 0),
  };
}

function boundsOverlap(a, b) {
  return a.minX <= b.maxX && a.maxX >= b.minX
    && a.minY <= b.maxY && a.maxY >= b.minY
    && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
}

function overlapsAnyColliderAt(object, position, gameObjects) {
  const bounds = objectBoundsAt(object, position);

  for (const other of gameObjects.values()) {
    if (other.id === object.id) continue;
    if (other.loadedInto) continue;

    if (boundsOverlap(bounds, objectBoundsAt(other))) {
      return true;
    }
  }

  return false;
}

export function moveMissileReleaseTowardOriginUntilClear(object, {
  config,
  gameObjects,
}) {
  if (!isMissileName(object.id)) return false;
  if (!gameObjects || !overlapsAnyColliderAt(object, object, gameObjects)) return false;

  const step = Math.max(0.01, config.missileReleaseDepenetrationStep ?? 0.25);
  const maxDistance = Math.max(0, config.missileReleaseDepenetrationMaxDistance ?? 60);
  const startX = Number(object.x);
  const startY = Number(object.y);

  // Try inward (toward center) then outward, interleaving so nearest clear wins.
  const inDir = startX >= 0 ? -1 : 1;
  for (let distance = step; distance <= maxDistance + 0.0001; distance += step) {
    for (const dir of [inDir, -inDir]) {
      const pos = { x: startX + dir * distance, y: startY, z: object.z };
      if (!overlapsAnyColliderAt(object, pos, gameObjects)) {
        object.x = pos.x;
        return true;
      }
    }
  }

  // Horizontal search failed — try upward.
  for (let distance = step; distance <= maxDistance + 0.0001; distance += step) {
    const pos = { x: startX, y: startY + distance, z: object.z };
    if (!overlapsAnyColliderAt(object, pos, gameObjects)) {
      object.y = pos.y;
      return true;
    }
  }

  return false;
}

export function applyMagneticDragForce(object, { config, dragState, physicsAggregates }) {
  const drag = dragState.get(object.id);
  const target = drag?.lastPoint;
  const aggregate = physicsAggregates.get(object.id);
  if (!target || !aggregate) return;

  const node = aggregate.transformNode;
  node.computeWorldMatrix(true);
  const grabLocal = drag.grabLocalPoint ?? { x: 0, y: 0, z: 0 };
  const grabWorldPoint = Vector3.TransformCoordinates(
    new Vector3(grabLocal.x, grabLocal.y, grabLocal.z),
    node.getWorldMatrix(),
  );
  const dx = Number(target.x) - grabWorldPoint.x;
  const dy = Number(target.y ?? grabWorldPoint.y) - grabWorldPoint.y;
  const dz = Number(target.z) - grabWorldPoint.z;
  const distance = Math.hypot(dx, dy, dz);
  const radiusLimit = Math.max(0.001, config.dragRadiusLimit ?? 8);
  if (distance <= 0.0001 || distance >= radiusLimit) return;

  const forceMagnitude = Math.max(0, config.dragForceMax ?? 420);
  const invDistance = 1 / distance;
  const force = new Vector3(
    dx * invDistance * forceMagnitude,
    dy * invDistance * forceMagnitude,
    dz * invDistance * forceMagnitude,
  );

  const linearVelocity = aggregate.body.getLinearVelocity?.() ?? Vector3.Zero();
  const angularVelocity = aggregate.body.getAngularVelocity?.() ?? Vector3.Zero();
  const radius = grabWorldPoint.subtract(node.getAbsolutePosition());
  const pointVelocity = linearVelocity.add(Vector3.Cross(angularVelocity, radius));
  const dampingMagnitude = Math.max(0, config.dragDampingMax ?? 80);
  const dampingForce = pointVelocity.scale(-dampingMagnitude);

  aggregate.body.applyForce(force.add(dampingForce), grabWorldPoint);
}
