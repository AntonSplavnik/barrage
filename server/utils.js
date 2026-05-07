import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { SERVER_CONFIG } from "./config.js";
import { BARRAGE_CONFIG } from "../public/config.js";

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

export function childRole(name) {
  if (name.includes("ColVis")) return "ColVis";
  if (name.includes("Visual") || name.includes("Vis")) return "Vis";
  if (name.includes("Collider") || name.includes("Col")) return "Col";
  return null;
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

export function isTrebuchetArmName(name) {
  const lowerName = name.toLowerCase();
  return lowerName.includes("trebuche") && lowerName.includes("arm");
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

export function clampAngularVelocity(value) {
  const max = BARRAGE_CONFIG.maxAngularVelocity ?? 540;
  return clamp(value, -max, max);
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

export function constrainedPointForObject(object, point) {
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

export function distance3(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
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
    && isTrebuchetName(transform.parent.name)
    && !lowerName.includes("visual")
    && !lowerName.includes("collider")
    && !lowerName.includes("col")
    && descendantsOf(transform).some((child) => child.name.toLowerCase().includes("missile-load-target"));
}

export function boundsForNodes(nodes) {
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

export function colliderBoundsFor(transform) {
  try {
    const colliderNodes = descendantsOf(transform).filter((child) => {
      const role = childRole(child.name);
      return role === "Col" || role === "ColVis";
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

export function estimateHalfHeight(transform) {
  return colliderBoundsFor(transform).halfY;
}

