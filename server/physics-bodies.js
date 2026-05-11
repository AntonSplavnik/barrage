import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate.js";
import { PhysicsPrestepType, PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin.js";
import {
  babylonToProtocolRotationZ,
  isBlockName,
  isMissileName,
  isTrebuchetName,
  rotationQuaternionForObject,
} from "./utils.js";

export function createPhysicsBodySystem({
  config,
  gameObjects,
  getScene,
  kingConvexPositions,
  physicsAggregates,
  physicsCollisionObservers,
  recordPhysicsContactEvent,
  serverConfig,
}) {
  function massForObject(name) {
    if (isBlockName(name)) return config.blockMass ?? serverConfig.dynamicMass;
    if (isMissileName(name)) return config.missileMass ?? serverConfig.dynamicMass;
    return serverConfig.dynamicMass;
  }

  function angularDampingForObject(object) {
    if (isTrebuchetName(object.id)) return 10;
    if (isBlockName(object.id)) return config.blockAngularDamping ?? 0.25;
    return 0.55;
  }

  function linearDampingForObject(object) {
    if (isTrebuchetName(object.id)) return 2.2;
    if (isMissileName(object.id)) return config.missileLinearDamping ?? 0.15;
    return 0.15;
  }

  function unregisterPhysicsAggregate(id) {
    const aggregate = physicsAggregates()?.get(id);
    const observer = physicsCollisionObservers()?.get(id);

    if (observer && aggregate?.body?.getCollisionObservable) {
      aggregate.body.getCollisionObservable().remove(observer);
    }
    physicsCollisionObservers()?.delete(id);
    aggregate?.body?.setCollisionCallbackEnabled?.(false);
  }

  function disposePhysicsAggregate(id) {
    const aggregates = physicsAggregates();
    const aggregate = aggregates?.get(id);
    if (!aggregate) return;

    unregisterPhysicsAggregate(id);
    aggregate.dispose();
    aggregates.delete(id);
  }

  function disposeAllPhysicsAggregates() {
    const aggregates = physicsAggregates();
    for (const id of [...(aggregates?.keys() ?? [])]) {
      disposePhysicsAggregate(id);
    }
    aggregates?.clear();
    physicsCollisionObservers()?.clear();
  }

  function registerPhysicsAggregate(object, aggregate) {
    unregisterPhysicsAggregate(object.id);

    aggregate.transformNode.metadata = {
      ...(aggregate.transformNode.metadata ?? {}),
      gameObjectId: object.id,
    };
    aggregate.body.transformNode.metadata = {
      ...(aggregate.body.transformNode.metadata ?? {}),
      gameObjectId: object.id,
    };

    if (object.dynamic && aggregate.body?.getCollisionObservable && aggregate.body?.setCollisionCallbackEnabled) {
      const observer = aggregate.body.getCollisionObservable().add(recordPhysicsContactEvent);
      physicsCollisionObservers().set(object.id, observer);
      aggregate.body.setCollisionCallbackEnabled(true);
    }

    physicsAggregates().set(object.id, aggregate);
  }

  function createPhysicsBodies() {
    const scene = getScene();
    for (const object of gameObjects().values()) {
      const convexPositions = kingConvexPositions().get(object.id);

      let physNode;
      let shapeType;
      let options;

      if (convexPositions?.length > 0) {
        try {
          const hullMesh = new Mesh(`hull-${object.id}`, scene);
          const vd = new VertexData();
          vd.positions = Array.from(convexPositions);
          const numVerts = convexPositions.length / 3;
          const indices = [];
          for (let j = 1; j < numVerts - 1; j++) indices.push(0, j, j + 1);
          vd.indices = indices;
          vd.applyToMesh(hullMesh, false);
          hullMesh.position.set(object.x, object.y, object.z);
          hullMesh.rotationQuaternion = rotationQuaternionForObject(object);
          hullMesh.computeWorldMatrix(true);
          physNode = hullMesh;
          shapeType = PhysicsShapeType.CONVEX_HULL;
          options = { mass: object.dynamic ? object.mass : 0, friction: object.friction, restitution: object.restitution };
        } catch (err) {
          console.warn(`Convex hull failed for ${object.id}, falling back to box:`, err.message);
        }
      }

      if (!physNode) {
        physNode = new TransformNode(`physics-${object.id}`, scene);
        physNode.position.set(object.x, object.y, object.z);
        physNode.rotationQuaternion = rotationQuaternionForObject(object);
        shapeType = isMissileName(object.id) ? PhysicsShapeType.SPHERE : PhysicsShapeType.BOX;
        options = {
          mass: object.dynamic ? object.mass : 0,
          friction: object.friction,
          restitution: object.restitution,
          center: new Vector3(object.offsetX, object.offsetY, object.offsetZ),
          extents: new Vector3(object.halfX * 2, object.halfY * 2, object.halfZ * 2),
          radius: Math.max(object.halfX, object.halfY, object.halfZ),
        };
      }

      const aggregate = new PhysicsAggregate(physNode, shapeType, options, scene);
      aggregate.body.disablePreStep = true;
      aggregate.body.setLinearDamping(linearDampingForObject(object));
      aggregate.body.setAngularDamping(angularDampingForObject(object));
      registerPhysicsAggregate(object, aggregate);
    }
  }

  function syncPhysicsBodyFromObject(object, velocity = null) {
    const aggregate = physicsAggregates().get(object.id);
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

  function physicsVelocityForObject(object) {
    return physicsAggregates().get(object.id)?.body.getLinearVelocity?.() ?? object;
  }

  function teleportPhysicsBody(aggregate) {
    aggregate.body.setPrestepType(PhysicsPrestepType.TELEPORT);
    aggregate.body._physicsPlugin.setPhysicsBodyTransformation(aggregate.body, aggregate.transformNode);
    aggregate.body.setPrestepType(PhysicsPrestepType.DISABLED);
  }

  function setPhysicsBodyTrigger(object, isTrigger) {
    const aggregate = physicsAggregates().get(object.id);
    if (!aggregate?.shape) return;

    aggregate.shape.isTrigger = isTrigger;
  }

  function constrainBodyToPlane(object) {
    const aggregate = physicsAggregates().get(object.id);
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

  function syncObjectFromPhysicsBody(object) {
    const aggregate = physicsAggregates().get(object.id);
    if (!aggregate) return false;

    constrainBodyToPlane(object);
    const node = aggregate.transformNode;
    const linearVelocity = aggregate.body.getLinearVelocity();
    const euler = node.rotationQuaternion?.toEulerAngles() ?? Vector3.Zero();

    object.x = node.position.x;
    object.y = node.position.y;
    object.z = object.originZ;
    object.rot = isTrebuchetName(object.id) ? 0 : babylonToProtocolRotationZ(euler.z);
    object.vx = linearVelocity.x;
    object.vy = linearVelocity.y;
    object.vz = 0;
    return true;
  }

  return {
    angularDampingForObject,
    constrainBodyToPlane,
    createPhysicsBodies,
    disposeAllPhysicsAggregates,
    disposePhysicsAggregate,
    massForObject,
    physicsVelocityForObject,
    registerPhysicsAggregate,
    setPhysicsBodyTrigger,
    syncObjectFromPhysicsBody,
    syncPhysicsBodyFromObject,
    teleportPhysicsBody,
    unregisterPhysicsAggregate,
  };
}
