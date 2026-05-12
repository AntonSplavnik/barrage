import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { isTrebuchetName as _isTrebuchetName } from "./game/entities.js";

export {
  clamp,
  clampVector,
  lerp,
  shortestAngleDeltaDegrees,
  lerpAngleDegrees,
  protocolToBabylonRotation,
  babylonToProtocolRotationZ,
  rotationQuaternionForObject,
} from "./math.js";

export {
  ARM_STATE_IDLE,
  ARM_STATE_AIMING,
  ARM_STATE_RELEASING,
  ARM_STATE_RETURNING,
  toWireObject,
  isDynamicName,
  isTrebuchetName,
  isMissileName,
  isKingName,
  isLeftSideTrebuchetName,
  sideSignForTrebuchet,
  restArmAngleForTrebuchet,
  normalReleaseVelocityMax,
  trebuchetFireVelocityMax,
  releaseVelocityForObject,
  constrainWorldBounds,
  constrainedPointForObject,
} from "./game/entities.js";

export function childRole(name) {
  if (name.includes("ColVis")) return "ColVis";
  if (name.includes("Visual") || name.includes("Vis")) return "Vis";
  if (name.includes("Collider") || name.includes("Col")) return "Col";
  return null;
}

export function isTrebuchetArmName(name) {
  const lowerName = name.toLowerCase();
  return lowerName.includes("trebuche") && lowerName.includes("arm");
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
    && _isTrebuchetName(transform.parent.name)
    && !lowerName.includes("visual")
    && !lowerName.includes("collider")
    && !lowerName.includes("col")
    && descendantsOf(transform).some((child) => child.name.toLowerCase().includes("missile-load-target"));
}

export function boundsForNodes(nodes) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
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
  if (!Number.isFinite(minX)) throw new Error("No bounds");
  return { min: new Vector3(minX, minY, minZ), max: new Vector3(maxX, maxY, maxZ) };
}

function isNestedTrebuchetArmDescendant(root, node) {
  let current = node.parent;
  while (current && current !== root) {
    if (isTrebuchetArmRoot(current)) return true;
    current = current.parent;
  }
  return false;
}

export function colliderBoundsFor(transform) {
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
    return { offsetX: 0, offsetY: 0, offsetZ: 0, halfX: 0.5, halfY: 0.5, halfZ: 0.5 };
  }
}
