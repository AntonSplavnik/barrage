import { scene } from "./engine.js";
import { protocolToBabylonRotation, degreesToRadians } from "./utils.js";

export const visualObjects = new Map();
export const visualBaseRotations = new Map();
export const latestObjectStates = new Map();
export const trebuchetArmNodes = new Map();
export const trebuchetLoadTargets = new Map();

let onAimUpdate = null;
export function setOnAimUpdate(fn) { onAimUpdate = fn; }

export function findGameplayRoot(node) {
  let current = node;

  while (current) {
    if (visualObjects.has(current.name)) {
      return current;
    }

    current = current.parent;
  }

  return null;
}

export function applyState(message) {
  for (const object of message.objects || []) {
    latestObjectStates.set(object.id, object);

    const visual = visualObjects.get(object.id);
    if (!visual) continue;

    visual.position.x = object.x;
    visual.position.y = object.y ?? visual.position.y;
    visual.position.z = object.z;
    visual.rotationQuaternion = null;
    const baseRotation = visualBaseRotations.get(object.id);
    if (baseRotation) {
      visual.rotation.x = baseRotation.x;
      visual.rotation.y = baseRotation.y;
      visual.rotation.z = baseRotation.z + protocolToBabylonRotation(object.rot || 0);
    } else {
      visual.rotation.z = protocolToBabylonRotation(object.rot || 0);
    }

    const arm = trebuchetArmNodes.get(object.id);
    if (arm && typeof object.armAngle === "number") {
      const armSign = object.player === 2 ? -1 : 1;
      arm.rotationQuaternion = null;
      arm.rotation.z = armSign * degreesToRadians(object.armAngle);
      arm.computeWorldMatrix(true);
    }

  }

  if (onAimUpdate) onAimUpdate();
}
