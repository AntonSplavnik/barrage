import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera.js";
import { Vector3, Quaternion } from "@babylonjs/core/Maths/math.vector.js";
import { Scene } from "@babylonjs/core/scene.js";
import "@babylonjs/core/Physics/v2/physicsEngineComponent.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin.js";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate.js";
import { PhysicsPrestepType, PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin.js";
import HavokPhysics from "@babylonjs/havok";
import { SERVER_CONFIG, getConfig } from "../config.js";
import { gameObjects } from "./state.js";
import { isTrebuchetName, isMissileName, isBlockName } from "./entities.js";
import { getTemplate } from "./templateRegistry.js";
import { rotationQuaternionForObject, clamp, lerpAngleDegrees } from "../math.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const engine = new NullEngine({
  renderHeight: 1,
  renderWidth: 1,
  textureSize: 1,
  deterministicLockstep: false,
});

export const scene = new Scene(engine);
scene.activeCamera = new FreeCamera("HeadlessCamera", new Vector3(0, 10, -10), scene);

export const physicsAggregates = new Map();

export async function enableHavokPhysics() {
  const wasmBinary = await fs.readFile(
    path.join(__dirname, "../../node_modules/@babylonjs/havok/lib/esm/HavokPhysics.wasm"),
  );
  const havokInterface = await HavokPhysics({ wasmBinary });
  const havokPlugin = new HavokPlugin(true, havokInterface);
  scene.enablePhysics(new Vector3(0, SERVER_CONFIG.gravity, 0), havokPlugin);
}

const arenaColliders = [];

function childRole(name) {
  if (name.includes("Frag")) return "Frag";
  if (name.includes("ColVis")) return "ColVis";
  if (name.includes("Visual") || name.includes("Vis")) return "Vis";
  if (name.includes("Collider") || name.includes("Col")) return "Col";
  return null;
}

export function createArenaColliders() {
  disposeArenaColliders();

  const arenaRoots = scene.rootNodes.filter((n) => n.name === "__root__");
  for (const root of arenaRoots) {
    const stack = [...root.getChildren()];
    while (stack.length > 0) {
      const node = stack.pop();
      if (typeof node.getChildren === "function") stack.push(...node.getChildren());

      const role = childRole(node.name);
      if (role !== "Col" && role !== "ColVis") continue;

      node.computeWorldMatrix(true);
      const bounds = typeof node.getHierarchyBoundingVectors === "function"
        ? node.getHierarchyBoundingVectors(true)
        : node.getBoundingInfo?.().boundingBox;
      if (!bounds) continue;

      const min = bounds.min ?? bounds.minimumWorld;
      const max = bounds.max ?? bounds.maximumWorld;
      const sizeX = max.x - min.x;
      const sizeY = max.y - min.y;
      const sizeZ = max.z - min.z;
      if (sizeX < 0.01 && sizeY < 0.01 && sizeZ < 0.01) continue;

      const centerX = (min.x + max.x) / 2;
      const centerY = (min.y + max.y) / 2;
      const centerZ = (min.z + max.z) / 2;

      const colNode = new TransformNode(`physics-arena-col-${node.name}`, scene);
      colNode.position.set(centerX, centerY, centerZ);
      colNode.rotationQuaternion = Quaternion.Identity();

      const aggregate = new PhysicsAggregate(colNode, PhysicsShapeType.BOX, {
        mass: 0,
        friction: SERVER_CONFIG.dynamicFriction,
        restitution: SERVER_CONFIG.dynamicRestitution,
        extents: new Vector3(Math.max(sizeX, 0.01), Math.max(sizeY, 0.01), Math.max(sizeZ, 0.01)),
      }, scene);
      aggregate.body.disablePreStep = true;

      arenaColliders.push(aggregate);
      console.log(`Arena collider "${node.name}": center=(${centerX.toFixed(2)}, ${centerY.toFixed(2)}, ${centerZ.toFixed(2)}) size=(${sizeX.toFixed(2)}, ${sizeY.toFixed(2)}, ${sizeZ.toFixed(2)})`);
    }
  }

  if (arenaColliders.length === 0) {
    console.log("No arena colliders found — creating fallback ground body.");
    const groundNode = new TransformNode("physics-ground", scene);
    groundNode.position.set(0, -0.5, 0);
    groundNode.rotationQuaternion = Quaternion.Identity();
    const aggregate = new PhysicsAggregate(groundNode, PhysicsShapeType.BOX, {
      mass: 0,
      friction: SERVER_CONFIG.dynamicFriction,
      restitution: SERVER_CONFIG.dynamicRestitution,
      extents: new Vector3(200, 1, 200),
    }, scene);
    aggregate.body.disablePreStep = true;
    arenaColliders.push(aggregate);
  }
}

function disposeArenaColliders() {
  for (const aggregate of arenaColliders) {
    aggregate.dispose();
  }
  arenaColliders.length = 0;
}

function fanIndices(vertexCount) {
  const indices = [];
  for (let i = 1; i < vertexCount - 1; i++) {
    indices.push(0, i, i + 1);
  }
  return indices;
}

export function createConvexHullBody(id, positions, position, rotation, physicsOptions) {
  const mesh = new Mesh(`physics-${id}`, scene);
  const vertexData = new VertexData();
  vertexData.positions = positions;
  vertexData.indices = fanIndices(positions.length / 3);
  vertexData.applyToMesh(mesh);

  mesh.position.copyFrom(position);
  mesh.rotationQuaternion = rotation;
  mesh.computeWorldMatrix(true);

  const aggregate = new PhysicsAggregate(mesh, PhysicsShapeType.CONVEX_HULL, {
    mass: physicsOptions.mass ?? 0,
    friction: physicsOptions.friction ?? SERVER_CONFIG.dynamicFriction,
    restitution: physicsOptions.restitution ?? SERVER_CONFIG.dynamicRestitution,
  }, scene);

  return aggregate;
}

function templatePathFromId(objectId) {
  const lastUnderscore = objectId.lastIndexOf("_");
  if (lastUnderscore < 0) return objectId;
  return objectId.substring(0, lastUnderscore);
}

export function createPhysicsBodies() {
  for (const object of gameObjects.values()) {
    const shape = object.shape ?? (isMissileName(object.id) ? "sphere" : "box");
    let aggregate;

    if (shape === "convex_hull") {
      const template = getTemplate(templatePathFromId(object.id));
      if (template?.convexPositions) {
        aggregate = createConvexHullBody(
          object.id,
          template.convexPositions,
          new Vector3(object.x, object.y, object.z),
          rotationQuaternionForObject(object),
          {
            mass: object.dynamic ? object.mass : 0,
            friction: object.friction,
            restitution: object.restitution,
          },
        );
      } else {
        console.warn(`No convex positions for "${object.id}", falling back to BOX`);
        aggregate = createBoxBody(object);
      }
    } else if (shape === "sphere") {
      aggregate = createSphereBody(object);
    } else {
      aggregate = createBoxBody(object);
    }

    aggregate.body.disablePreStep = true;
    aggregate.body.setLinearDamping(isTrebuchetName(object.id) ? 2.2 : 0.15);
    aggregate.body.setAngularDamping(isTrebuchetName(object.id) ? 10 : 0.55);

    if (isMissileName(object.id) || isBlockName(object.id)) {
      aggregate.body.setCollisionCallbackEnabled(true);
    }

    physicsAggregates.set(object.id, aggregate);
  }
}

function createBoxBody(object) {
  const node = new TransformNode(`physics-${object.id}`, scene);
  node.position.set(object.x, object.y, object.z);
  node.rotationQuaternion = rotationQuaternionForObject(object);

  return new PhysicsAggregate(node, PhysicsShapeType.BOX, {
    mass: object.dynamic ? object.mass : 0,
    friction: object.friction,
    restitution: object.restitution,
    center: new Vector3(object.offsetX, object.offsetY, object.offsetZ),
    extents: new Vector3(object.halfX * 2, object.halfY * 2, object.halfZ * 2),
  }, scene);
}

function createSphereBody(object) {
  const node = new TransformNode(`physics-${object.id}`, scene);
  node.position.set(object.x, object.y, object.z);
  node.rotationQuaternion = rotationQuaternionForObject(object);

  return new PhysicsAggregate(node, PhysicsShapeType.SPHERE, {
    mass: object.dynamic ? object.mass : 0,
    friction: object.friction,
    restitution: object.restitution,
    radius: Math.max(object.halfX, object.halfY, object.halfZ),
  }, scene);
}

export function createPhysicsBodyForObject(object) {
  const shape = object.shape ?? (isMissileName(object.id) ? "sphere" : "box");
  let aggregate;

  if (shape === "convex_hull") {
    const template = getTemplate(templatePathFromId(object.id));
    if (template?.convexPositions) {
      aggregate = createConvexHullBody(
        object.id,
        template.convexPositions,
        new Vector3(object.x, object.y, object.z),
        rotationQuaternionForObject(object),
        {
          mass: object.dynamic ? object.mass : 0,
          friction: object.friction,
          restitution: object.restitution,
        },
      );
    } else {
      aggregate = createBoxBody(object);
    }
  } else if (shape === "sphere") {
    aggregate = createSphereBody(object);
  } else {
    aggregate = createBoxBody(object);
  }

  aggregate.body.disablePreStep = true;
  aggregate.body.setLinearDamping(isTrebuchetName(object.id) ? 2.2 : 0.15);
  aggregate.body.setAngularDamping(isTrebuchetName(object.id) ? 10 : 0.55);

  if (isMissileName(object.id) || isBlockName(object.id)) {
    aggregate.body.setCollisionCallbackEnabled(true);
  }

  physicsAggregates.set(object.id, aggregate);
  return aggregate;
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

  const zDrift = Math.abs(node.position.z - object.originZ);
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
  if (isTrebuchetName(object.id) || zDrift > 0.001) {
    teleportPhysicsBody(aggregate);
  }
  aggregate.body.setLinearVelocity(linearVelocity);
  aggregate.body.setAngularVelocity(angularVelocity);
}

export function returnDraggedObjectUpright(object) {
  if (!object.dynamic || isTrebuchetName(object.id) || isMissileName(object.id) || object.loadedInto) return;

  const amount = clamp(getConfig("dragUprightLerp"), 0, 1);
  object.rot = lerpAngleDegrees(object.rot ?? 0, 0, amount);

  const aggregate = physicsAggregates.get(object.id);
  if (aggregate) {
    aggregate.body.setAngularVelocity(Vector3.Zero());
  }
}
