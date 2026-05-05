import { gameObjects } from "./state.js";
import { SERVER_CONFIG } from "./config.js";
import { BARRAGE_CONFIG } from "../public/config.js";
import {
  isTrebuchetName,
  isMissileName,
  isGroundName,
  aabbFor,
  clampVector,
  velocityComponent,
  setVelocityComponent,
  constrainedPointForObject,
  normalReleaseVelocityMax,
} from "./utils.js";

function overlapOnAxis(aMin, aMax, bMin, bMax) {
  return Math.min(aMax, bMax) - Math.max(aMin, bMin);
}

function resolveObjectCollision(object, other, { preferHorizontal = false } = {}) {
  if (object.id === other.id || isGroundName(other.id)) return;

  const a = aabbFor(object);
  const b = aabbFor(other);
  const overlapX = overlapOnAxis(a.minX, a.maxX, b.minX, b.maxX);
  const overlapY = overlapOnAxis(a.minY, a.maxY, b.minY, b.maxY);
  const overlapZ = overlapOnAxis(a.minZ, a.maxZ, b.minZ, b.maxZ);

  if (overlapX <= 0 || overlapY <= 0 || overlapZ <= 0) return;

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

export function resolveCollisionsForObject(object, { includeDragged = false } = {}) {
  if (object.loadedInto) return;
  if (!object.dynamic || (!includeDragged && object.draggedBy) || isTrebuchetName(object.id)) return;

  for (const other of gameObjects.values()) {
    if (other.id === object.id) continue;
    if (other.loadedInto) continue;
    if (!includeDragged && other.draggedBy) continue;
    resolveObjectCollision(object, other, { preferHorizontal: Boolean(object.draggedBy) });
  }
}

export function resolveCollisions() {
  const objects = [...gameObjects.values()];

  for (let i = 0; i < SERVER_CONFIG.collisionIterations; i += 1) {
    for (const object of objects) {
      resolveCollisionsForObject(object);
    }
  }
}
