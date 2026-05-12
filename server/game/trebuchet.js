import { gameObjects, loadTargets } from "./state.js";
import { BARRAGE_CONFIG } from "../../public/config.js";
import {
  isTrebuchetName,
  isMissileName,
  sideSignForTrebuchet,
  restArmAngleForTrebuchet,
  releaseVelocityForObject,
  trebuchetFireVelocityMax,
  ARM_STATE_IDLE,
  ARM_STATE_RELEASING,
  ARM_STATE_RETURNING,
} from "./entities.js";
import { clamp, lerp } from "../math.js";
import { setPhysicsBodyTrigger, syncPhysicsBodyFromObject } from "./physics.js";

export function updateTrebuchetFireState(dt) {
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
    const restArmAngle = restArmAngleForTrebuchet(trebuchet);
    const previousArmAngle = trebuchet.armAngle ?? startArmAngle;
    const velocity = trebuchet.pendingShot?.velocity ?? { x: 0, y: 0, z: 0 };
    trebuchet.armAngle = lerp(startArmAngle, 0, progress);

    const shouldReleaseAtRest = !trebuchet.pendingShot?.released
      && (startArmAngle <= restArmAngle || (previousArmAngle > restArmAngle && trebuchet.armAngle <= restArmAngle));

    if (shouldReleaseAtRest) {
      releaseLoadedMissileFromTrebuchet(trebuchet, velocity, restArmAngle);
      if (trebuchet.pendingShot) {
        trebuchet.pendingShot.released = true;
      }
    }

    if (progress < 1) continue;

    if (!trebuchet.pendingShot?.released) {
      releaseLoadedMissileFromTrebuchet(trebuchet, velocity, restArmAngle);
    }

    trebuchet.fireState = ARM_STATE_RETURNING;
    trebuchet.pendingShot = null;
    trebuchet.returnStartArmAngle = trebuchet.armAngle;
    trebuchet.releaseElapsedMs = 0;
  }
}

export function loadTargetForTrebuchet(trebuchet) {
  const target = loadTargets.get(trebuchet.id) ?? loadTargets.get("default") ?? null;
  if (!target) return null;

  if (target.targetNode && target.rootNode) {
    target.rootNode.position.x = trebuchet.x;
    target.rootNode.position.y = trebuchet.y;
    target.rootNode.position.z = trebuchet.z;

    if (target.armNode && typeof trebuchet.armAngle === "number") {
      target.armNode.rotationQuaternion = null;
      target.armNode.rotation.z = (trebuchet.armAngle * Math.PI) / 180;
    }

    target.rootNode.computeWorldMatrix(true);
    target.armNode?.computeWorldMatrix(true);
    target.targetNode.computeWorldMatrix(true);

    const targetPosition = target.targetNode.getAbsolutePosition();
    const rootPosition = target.rootNode.getAbsolutePosition();

    return {
      x: trebuchet.x - (targetPosition.x - rootPosition.x),
      y: trebuchet.y + (targetPosition.y - rootPosition.y),
      z: trebuchet.z + (targetPosition.z - rootPosition.z),
    };
  }

  return {
    x: trebuchet.x + target.offsetX,
    y: trebuchet.y + target.offsetY,
    z: trebuchet.z + target.offsetZ,
  };
}

export function maybeLoadMissile(missile) {
  if (!isMissileName(missile.id)) return false;

  for (const trebuchet of gameObjects.values()) {
    if (!isTrebuchetName(trebuchet.id) || trebuchet.loaded) continue;

    const range = BARRAGE_CONFIG.missileLoadRange ?? 6;
    const target = loadTargetForTrebuchet(trebuchet);
    if (!target) continue;

    const rootDistance = Math.hypot(missile.x - trebuchet.x, missile.z - trebuchet.z);
    const targetDistance = Math.hypot(missile.x - target.x, missile.z - target.z);
    if (Math.min(rootDistance, targetDistance) > range) continue;

    missile.x = target.x;
    missile.y = target.y;
    missile.z = target.z;
    missile.vx = 0;
    missile.vy = 0;
    missile.vz = 0;
    missile.loadedInto = trebuchet.id;
    setPhysicsBodyTrigger(missile, true);
    trebuchet.loaded = true;
    trebuchet.loadedMissileId = missile.id;
    trebuchet.fireState = ARM_STATE_IDLE;
    trebuchet.armAngle = restArmAngleForTrebuchet();
    return true;
  }

  return false;
}

export function updateTrebuchetAim(trebuchet, point) {
  const start = trebuchet.aimStart;
  if (!start) return;

  const requested = {
    x: Number(point.x),
    y: Number(point.y ?? start.y),
    z: Number(point.z ?? start.z),
  };
  const pullX = requested.x - start.x;
  const pullY = requested.y - start.y;
  const pullDistance = Math.hypot(pullX, pullY);
  const maxPullDistance = BARRAGE_CONFIG.aimMaxPullDistance ?? 6;
  const clampedDistance = clamp(pullDistance, 0, maxPullDistance);
  const pullScale = pullDistance > 0.0001 ? clampedDistance / pullDistance : 0;
  const current = {
    x: start.x + pullX * pullScale,
    y: start.y + pullY * pullScale,
    z: requested.z,
  };
  trebuchet.aimCurrent = current;

  const pullRatio = clampedDistance / Math.max(0.001, maxPullDistance);
  const maxExtra = BARRAGE_CONFIG.trebuchetArmPullbackMaxDegrees
    ?? BARRAGE_CONFIG.aimArmMaxExtraDegrees
    ?? 45;
  const restAngle = Math.abs(BARRAGE_CONFIG.trebuchetArmRestRotationZDegrees ?? 15);

  trebuchet.armAngle = restAngle + pullRatio * maxExtra;
}

export function beginTrebuchetRelease(trebuchet) {
  const start = trebuchet.aimStart;
  const current = trebuchet.aimCurrent ?? start;
  if (!start || !current) return;

  const powerScale = BARRAGE_CONFIG.aimPowerScale ?? 8;
  const shotDirectionX = sideSignForTrebuchet(trebuchet.id);
  const velocity = releaseVelocityForObject({ id: "missile" }, {
    x: Math.abs(start.x - current.x) * powerScale * shotDirectionX,
    y: (start.y - current.y) * powerScale,
    z: (start.z - current.z) * powerScale,
  }, trebuchetFireVelocityMax());

  trebuchet.fireState = ARM_STATE_RELEASING;
  trebuchet.pendingShot = {
    velocity,
    released: false,
    startArmAngle: trebuchet.armAngle ?? (BARRAGE_CONFIG.trebuchetArmRestRotationZDegrees ?? 15),
  };
  trebuchet.releaseElapsedMs = 0;
}

function targetPointForTrebuchetAtArmAngle(trebuchet, armAngle) {
  const previousAngle = trebuchet.armAngle;
  trebuchet.armAngle = armAngle;
  const target = loadTargetForTrebuchet(trebuchet);
  const point = target ? { x: target.x, y: target.y, z: target.z } : null;
  trebuchet.armAngle = previousAngle;
  loadTargetForTrebuchet(trebuchet);
  return point;
}

export function releaseLoadedMissileFromTrebuchet(trebuchet, velocity, armAngle = null) {
  const missile = trebuchet.loadedMissileId ? gameObjects.get(trebuchet.loadedMissileId) : null;
  if (!missile || missile.loadedInto !== trebuchet.id) return false;

  const target = armAngle === null
    ? loadTargetForTrebuchet(trebuchet)
    : targetPointForTrebuchetAtArmAngle(trebuchet, armAngle);

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

  trebuchet.loaded = false;
  trebuchet.loadedMissileId = null;
  trebuchet.aimedBy = null;
  trebuchet.aimStart = null;
  trebuchet.aimCurrent = null;
  return true;
}
