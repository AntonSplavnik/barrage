import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { scene } from "./physics.js";
import { gameObjects, loadTargets } from "./state.js";
import { SERVER_CONFIG } from "../config.js";
import {
  isDynamicName,
  isTrebuchetName,
  isMissileName,
  isKingName,
  restArmAngleForTrebuchet,
  ARM_STATE_IDLE,
} from "./entities.js";
import { createPhysicsBodies } from "./physics.js";

function childRole(name) {
  if (name.includes("ColVis")) return "ColVis";
  if (name.includes("Visual") || name.includes("Vis")) return "Vis";
  if (name.includes("Collider") || name.includes("Col")) return "Col";
  return null;
}

function descendantsOf(transform) {
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

function isTrebuchetArmName(name) {
  const lowerName = name.toLowerCase();
  return lowerName.includes("trebuche") && lowerName.includes("arm");
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

function boundsForNodes(nodes) {
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

function colliderBoundsFor(transform) {
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

function findGameplayRootAncestor(node) {
  let current = node.parent;
  let candidate = null;
  while (current) {
    if (isTrebuchetName(current.name)) candidate = current;
    if (current.parent?.name === "__root__") {
      return isTrebuchetName(current.name) ? current : candidate;
    }
    current = current.parent;
  }
  return candidate;
}

function findTrebuchetArmAncestor(node) {
  let current = node.parent;
  while (current) {
    if (isTrebuchetArmRoot(current)) return current;
    current = current.parent;
  }
  return null;
}

export function registerMeshRoots() {
  loadTargets.clear();

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

  for (const transform of scene.transformNodes) {
    if (transform.parent && transform.parent.name !== "__root__") continue;
    const hasGameplayChild = descendantsOf(transform).some((child) => childRole(child.name));
    if (!hasGameplayChild) continue;

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
      mass: dynamic ? SERVER_CONFIG.dynamicMass : 0,
      friction: dynamic ? SERVER_CONFIG.dynamicFriction : 1,
      restitution: dynamic ? SERVER_CONFIG.dynamicRestitution : 0,
      ...(isTrebuchetName(transform.name) ? {
        loaded: false,
        loadedMissileId: null,
        fireState: ARM_STATE_IDLE,
        armAngle: restArmAngleForTrebuchet(),
        aimedBy: null,
        aimStart: null,
        aimCurrent: null,
        pendingShot: null,
        returnStartArmAngle: null,
        releaseElapsedMs: 0,
      } : {}),
      ...(isMissileName(transform.name) ? { loadedInto: null } : {}),
      ...(isKingName(transform.name) ? { hits: 0, maxHits: 3 } : {}),
    });
  }

  createPhysicsBodies();
}
