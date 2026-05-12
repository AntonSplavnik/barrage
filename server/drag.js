import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import {
  clamp,
  clampVector,
  isBlockName,
  isLeftSideTrebuchetName,
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
  const clientVelocity = releaseVelocityForObject(object, message.velocity);
  const clientSpeed = Math.hypot(clientVelocity.x, clientVelocity.y, clientVelocity.z);

  if (clientSpeed > 0.1) {
    return clientVelocity;
  }

  return releaseVelocityForObject(object, velocityFromDragState(object, message.point, { dragState }));
}

export function constrainedPointForObject(object, point, { config }) {
  if (!isTrebuchetName(object.id)) {
    return {
      x: Number(point.x),
      y: Number(point.y ?? object.y),
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
