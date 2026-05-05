import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { scene, gameObjects, physicsAggregates } from "./state.js";
import { SERVER_CONFIG, TICK_MS } from "./config.js";
import { BARRAGE_CONFIG } from "../public/config.js";
import {
  isTrebuchetName,
  constrainWorldBounds,
  constrainedPointForObject,
  babylonToProtocolRotationZ,
  lerp,
  clamp,
  restArmAngleForTrebuchet,
  ARM_STATE_IDLE,
  ARM_STATE_RELEASING,
  ARM_STATE_RETURNING,
} from "./utils.js";
import {
  syncPhysicsBodyFromObject,
  setPhysicsBodyTrigger,
  constrainBodyToPlane,
  returnDraggedObjectUpright,
} from "./physics.js";
import { resolveCollisions } from "./collision.js";
import { loadTargetForTrebuchet } from "./trebuchet.js";

function updateTrebuchetFireState(dt) {
  for (const trebuchet of gameObjects.values()) {
    if (!isTrebuchetName(trebuchet.id)) continue;

    if (trebuchet.fireState === ARM_STATE_RETURNING) {
      const durationMs = Math.max(1, BARRAGE_CONFIG.fireReturnAnimationMs ?? 220);
      trebuchet.releaseElapsedMs = (trebuchet.releaseElapsedMs ?? 0) + dt * 1000;
      const progress = clamp(trebuchet.releaseElapsedMs / durationMs, 0, 1);
      const startArmAngle = trebuchet.returnStartArmAngle ?? trebuchet.armAngle ?? 0;
      const restArmAngle = restArmAngleForTrebuchet();
      trebuchet.armAngle = lerp(startArmAngle, restArmAngle, progress);

      if (progress >= 1) {
        trebuchet.armAngle = restArmAngle;
        trebuchet.fireState = ARM_STATE_IDLE;
        trebuchet.returnStartArmAngle = null;
        trebuchet.releaseElapsedMs = 0;
      }

      continue;
    }

    if (trebuchet.fireState !== ARM_STATE_RELEASING) continue;

    const durationMs = Math.max(1, BARRAGE_CONFIG.fireReleaseAnimationMs ?? 180);
    trebuchet.releaseElapsedMs = (trebuchet.releaseElapsedMs ?? 0) + dt * 1000;
    const progress = clamp(trebuchet.releaseElapsedMs / durationMs, 0, 1);
    const startArmAngle = trebuchet.pendingShot?.startArmAngle ?? trebuchet.armAngle ?? 0;
    trebuchet.armAngle = lerp(startArmAngle, 0, progress);

    if (progress < 1) continue;

    const missile = trebuchet.loadedMissileId ? gameObjects.get(trebuchet.loadedMissileId) : null;
    const velocity = trebuchet.pendingShot?.velocity ?? { x: 0, y: 0, z: 0 };

    if (missile && missile.loadedInto === trebuchet.id) {
      const target = loadTargetForTrebuchet(trebuchet);
      if (target) {
        missile.x = target.x;
        missile.y = target.y;
        missile.z = target.z;
      }
      missile.loadedInto = null;
      setPhysicsBodyTrigger(missile, false);
      missile.vx = velocity.x;
      missile.vy = velocity.y;
      missile.vz = velocity.z;
      syncPhysicsBodyFromObject(missile, velocity);
    }

    trebuchet.loaded = false;
    trebuchet.loadedMissileId = null;
    trebuchet.fireState = ARM_STATE_RETURNING;
    trebuchet.aimedBy = null;
    trebuchet.aimStart = null;
    trebuchet.aimCurrent = null;
    trebuchet.pendingShot = null;
    trebuchet.returnStartArmAngle = trebuchet.armAngle;
    trebuchet.releaseElapsedMs = 0;
  }
}

function simulateHavokPhysics() {
  updateTrebuchetFireState(TICK_MS / 1000);

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
      returnDraggedObjectUpright(object);
      syncPhysicsBodyFromObject(object, { x: 0, y: 0, z: 0 });
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

  scene.getPhysicsEngine()?._step(TICK_MS / 1000);

  for (const object of gameObjects.values()) {
    if (!object.dynamic) continue;
    if (object.draggedBy || object.loadedInto) continue;

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
  }
}

export function simulatePhysics(dt) {
  if (physicsAggregates.size > 0) {
    simulateHavokPhysics();
    return;
  }

  updateTrebuchetFireState(dt);

  for (const object of gameObjects.values()) {
    if (!object.dynamic || object.draggedBy) continue;
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
      continue;
    }

    if (isTrebuchetName(object.id)) {
      object.x += object.vx * dt;
      object.x = constrainedPointForObject(object, { x: object.x, y: object.y, z: object.z }).x;
      object.y = object.originY;
      object.z = object.originZ;
      object.vx *= Math.max(0, 1 - SERVER_CONFIG.trebuchetReleaseFriction * dt);
      if (Math.abs(object.vx) < 0.01) object.vx = 0;
      object.vy = 0;
      object.vz = 0;
      continue;
    }

    object.vy += SERVER_CONFIG.gravity * dt;
    object.x += object.vx * dt;
    object.y += object.vy * dt;
    object.z += object.vz * dt;
    constrainWorldBounds(object);

    const floorY = SERVER_CONFIG.groundY + object.halfY - object.offsetY;
    if (object.y < floorY) {
      object.y = floorY;

      if (Math.abs(object.vy) > 0.4) {
        object.vy = -object.vy * object.restitution;
      } else {
        object.vy = 0;
      }

      const frictionScale = Math.max(0, 1 - object.friction * dt * 3);
      object.vx *= frictionScale;
      object.vz *= frictionScale;

      if (Math.abs(object.vx) < 0.01) object.vx = 0;
      if (Math.abs(object.vz) < 0.01) object.vz = 0;
    }
  }

  resolveCollisions();
}
