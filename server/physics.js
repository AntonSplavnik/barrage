import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Vector3, Quaternion } from "@babylonjs/core/Maths/math.vector.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin.js";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate.js";
import { PhysicsPrestepType, PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin.js";
import HavokPhysics from "@babylonjs/havok";
import { scene, gameObjects, physicsAggregates } from "./state.js";
import { SERVER_CONFIG } from "./config.js";
import { BARRAGE_CONFIG } from "../public/config.js";
import {
  isTrebuchetName,
  isMissileName,
  rotationQuaternionForObject,
  clamp,
  lerpAngleDegrees,
} from "./utils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function enableHavokPhysics() {
  const wasmBinary = await fs.readFile(
    path.join(__dirname, "../node_modules/@babylonjs/havok/lib/esm/HavokPhysics.wasm"),
  );
  const havokInterface = await HavokPhysics({ wasmBinary });
  const havokPlugin = new HavokPlugin(true, havokInterface);
  scene.enablePhysics(new Vector3(0, SERVER_CONFIG.gravity, 0), havokPlugin);
}

export function createPhysicsBodies() {
  for (const object of gameObjects.values()) {
    const node = new TransformNode(`physics-${object.id}`, scene);
    node.position.set(object.x, object.y, object.z);
    node.rotationQuaternion = rotationQuaternionForObject(object);

    const shapeType = isMissileName(object.id) ? PhysicsShapeType.SPHERE : PhysicsShapeType.BOX;
    const options = {
      mass: object.dynamic ? object.mass : 0,
      friction: object.friction,
      restitution: object.restitution,
      center: new Vector3(object.offsetX, object.offsetY, object.offsetZ),
      extents: new Vector3(object.halfX * 2, object.halfY * 2, object.halfZ * 2),
      radius: Math.max(object.halfX, object.halfY, object.halfZ),
    };

    const aggregate = new PhysicsAggregate(node, shapeType, options, scene);
    aggregate.body.disablePreStep = true;
    aggregate.body.setLinearDamping(isTrebuchetName(object.id) ? 2.2 : 0.15);
    aggregate.body.setAngularDamping(isTrebuchetName(object.id) ? 10 : 0.55);
    physicsAggregates.set(object.id, aggregate);
  }
}

export function syncPhysicsBodyFromObject(object, velocity = null) {
  const aggregate = physicsAggregates.get(object.id);
  if (!aggregate) return;

  const node = aggregate.transformNode;
  node.position.set(object.x, object.y, object.z);
  node.rotationQuaternion = rotationQuaternionForObject(object);
  node.computeWorldMatrix(true);
  teleportPhysicsBody(aggregate);

  if (velocity) {
    aggregate.body.setLinearVelocity(new Vector3(velocity.x, velocity.y, velocity.z));
  }
}

export function teleportPhysicsBody(aggregate) {
  aggregate.body.setPrestepType(PhysicsPrestepType.TELEPORT);
  aggregate.body._physicsPlugin.setPhysicsBodyTransformation(aggregate.body, aggregate.transformNode);
  aggregate.body.setPrestepType(PhysicsPrestepType.DISABLED);
}

export function setPhysicsBodyTrigger(object, isTrigger) {
  const aggregate = physicsAggregates.get(object.id);
  if (!aggregate?.shape) return;

  aggregate.shape.isTrigger = isTrigger;
}

export function constrainBodyToPlane(object) {
  const aggregate = physicsAggregates.get(object.id);
  if (!aggregate) return;

  const node = aggregate.transformNode;
  const linearVelocity = aggregate.body.getLinearVelocity();
  const angularVelocity = aggregate.body.getAngularVelocity();

  node.position.z = object.originZ;
  linearVelocity.z = 0;

  if (isTrebuchetName(object.id)) {
    node.position.y = object.originY;
    node.rotationQuaternion = rotationQuaternionForObject({ rot: 0 });
    linearVelocity.y = 0;
    angularVelocity.x = 0;
    angularVelocity.y = 0;
    angularVelocity.z = 0;
  } else {
    const euler = node.rotationQuaternion?.toEulerAngles() ?? Vector3.Zero();
    node.rotationQuaternion = Quaternion.FromEulerAngles(0, 0, euler.z);
    angularVelocity.x = 0;
    angularVelocity.y = 0;
  }

  node.computeWorldMatrix(true);
  if (isTrebuchetName(object.id) || Math.abs(node.position.z - object.originZ) > 0.001) {
    teleportPhysicsBody(aggregate);
  }
  aggregate.body.setLinearVelocity(linearVelocity);
  aggregate.body.setAngularVelocity(angularVelocity);
}

export function shouldReturnUprightWhileDragged(object) {
  return object.dynamic
    && !isTrebuchetName(object.id)
    && !isMissileName(object.id)
    && !object.loadedInto;
}

export function returnDraggedObjectUpright(object) {
  if (!shouldReturnUprightWhileDragged(object)) return;

  const amount = clamp(BARRAGE_CONFIG.dragUprightLerp ?? 0.25, 0, 1);
  object.rot = lerpAngleDegrees(object.rot ?? 0, 0, amount);

  const aggregate = physicsAggregates.get(object.id);
  if (aggregate) {
    aggregate.body.setAngularVelocity(Vector3.Zero());
  }
}
