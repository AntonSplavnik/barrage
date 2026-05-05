import { scene } from "./engine.js";
import { protocolToBabylonRotation, degreesToRadians } from "./utils.js";

export const visualObjects = new Map();
export const latestObjectStates = new Map();
export const trebuchetArmNodes = new Map();

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
    visual.rotation.z = protocolToBabylonRotation(object.rot || 0);

    const arm = trebuchetArmNodes.get(object.id);
    if (arm && typeof object.armAngle === "number") {
      arm.rotationQuaternion = null;
      arm.rotation.z = degreesToRadians(object.armAngle);
      arm.computeWorldMatrix(true);
    }
  }
}
