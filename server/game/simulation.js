import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { gameObjects } from "./state.js";
import {
  scene,
  physicsAggregates,
  syncPhysicsBodyFromObject,
  constrainBodyToPlane,
  teleportPhysicsBody,
  returnDraggedObjectUpright,
} from "./physics.js";
import { SERVER_CONFIG, TICK_MS, getConfig } from "../config.js";
import { isTrebuchetName } from "./entities.js";
import { babylonToProtocolRotationZ } from "../math.js";
import { updateTrebuchetFireState, loadTargetForTrebuchet } from "./trebuchet.js";
import { usesMagneticDrag, applyMagneticDragForce, tickMissileUnstuck, unstuckMissiles } from "./drag.js";

export function simulatePhysics() {
  const scaledDt = (TICK_MS / 1000) * getConfig("physicsTimeScale");
  updateTrebuchetFireState(scaledDt);

  for (const object of gameObjects.values()) {
    if (!object.dynamic) continue;

    if (object.loadedInto) {
      const trebuchet = gameObjects.get(object.loadedInto);
      const target = trebuchet ? loadTargetForTrebuchet(trebuchet) : null;
      if (target) {
        object.x = target.x;
        object.y = target.y;
        object.z = target.z;
      }
      object.vx = 0;
      object.vy = 0;
      object.vz = 0;
      syncPhysicsBodyFromObject(object, { x: 0, y: 0, z: 0 });
      continue;
    }

    if (object.draggedBy) {
      if (usesMagneticDrag(object)) {
        applyMagneticDragForce(object);
      } else {
        returnDraggedObjectUpright(object);
        syncPhysicsBodyFromObject(object, { x: 0, y: 0, z: 0 });
      }
      continue;
    }

    if (isTrebuchetName(object.id)) {
      const aggregate = physicsAggregates.get(object.id);
      if (!aggregate) continue;
      const velocity = aggregate.body.getLinearVelocity();
      velocity.y = 0;
      velocity.z = 0;
      aggregate.body.setLinearVelocity(velocity);
    }
  }

  tickMissileUnstuck();
  scene.getPhysicsEngine()?._step(scaledDt);

  for (const object of gameObjects.values()) {
    if (!object.dynamic) continue;
    if (object.loadedInto) continue;
    if (object.draggedBy && !usesMagneticDrag(object)) continue;
    if (unstuckMissiles.has(object.id)) continue;

    const aggregate = physicsAggregates.get(object.id);
    if (!aggregate) continue;

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

    const floorY = getConfig("groundY") + object.halfY - (object.offsetY ?? 0);
    if (object.y < floorY) {
      object.y = floorY;
      if (object.vy < 0) object.vy = 0;
      node.position.y = floorY;
      node.computeWorldMatrix(true);
      teleportPhysicsBody(aggregate);
      aggregate.body.setLinearVelocity(new Vector3(object.vx, 0, 0));
    }
  }
}
