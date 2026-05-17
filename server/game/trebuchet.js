import { gameObjects, loadTargets } from "./state.js";
import { getConfig } from "../config.js";
import {
  isTrebuchetName,
  isMissileName,
  restArmAngleForTrebuchet,
  releaseVelocityForObject,
  trebuchetFireVelocityMax,
  ARM_STATE_IDLE,
  ARM_STATE_RELEASING,
  ARM_STATE_RETURNING,
} from "./entities.js";
import { clamp, lerp } from "../math.js";
import { setPhysicsBodyTrigger, syncPhysicsBodyFromObject } from "./physics.js";
import { getActiveLevel, getHookContext, callHook } from "./modeRunner.js";
import { computeArcPoints } from "./trajectoryArc.js";

function clearArcFields(trebuchet) {
  trebuchet.shotVelocity = null;
  trebuchet.shotStartPoint = null;
  trebuchet.shotArcPoints = null;
  trebuchet.powerRatio = null;
}

export function updateTrebuchetFireState(dt) {
  for (const trebuchet of gameObjects.values()) {
    if (!isTrebuchetName(trebuchet.id)) continue;

    if (trebuchet.fireState === ARM_STATE_RETURNING) {
      const durationMs = Math.max(1, getConfig("fireReturnAnimationMs"));
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

    const durationMs = Math.max(1, getConfig("fireReleaseAnimationMs"));
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
  const target = loadTargets.get(trebuchet.id) ?? null;
  if (!target) return null;

  if (target.targetNode && target.rootNode) {
    target.rootNode.position.x = trebuchet.x;
    target.rootNode.position.y = trebuchet.y;
    target.rootNode.position.z = trebuchet.z;

    if (target.armNode && typeof trebuchet.armAngle === "number") {
      const armSign = trebuchet.player === 2 ? -1 : 1;
      target.armNode.rotationQuaternion = null;
      target.armNode.rotation.z = armSign * (trebuchet.armAngle * Math.PI) / 180;
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

    const range = getConfig("missileLoadRange");
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
  const rawPullX = requested.x - start.x;
  const isWrongDirection =
    (trebuchet.player === 1 && rawPullX > 0) ||
    (trebuchet.player === 2 && rawPullX < 0);
  const pullX = isWrongDirection ? 0 : rawPullX;
  const pullY = isWrongDirection ? 0 : requested.y - start.y;
  const pullDistance = Math.hypot(pullX, pullY);
  const maxPullDistance = getConfig("aimMaxPullDistance");
  const clampedDistance = clamp(pullDistance, 0, maxPullDistance);
  const pullScale = pullDistance > 0.0001 ? clampedDistance / pullDistance : 0;
  const current = {
    x: start.x + pullX * pullScale,
    y: start.y + pullY * pullScale,
    z: requested.z,
  };
  trebuchet.aimCurrent = current;

  const pullRatio = clampedDistance / Math.max(0.001, maxPullDistance);
  const maxExtra = getConfig("trebuchetArmPullbackMaxDegrees");
  const restAngle = Math.abs(getConfig("trebuchetArmRestRotationZDegrees"));

  trebuchet.armAngle = restAngle + pullRatio * maxExtra;

  if (isWrongDirection) {
    clearArcFields(trebuchet);
    return;
  }

  const powerScale = getConfig("aimPowerScale");
  const shotDirectionX = trebuchet.player === 1 ? 1 : -1;
  const shotVelocity = releaseVelocityForObject({ id: "missile" }, {
    x: Math.abs(start.x - current.x) * powerScale * shotDirectionX,
    y: (start.y - current.y) * powerScale,
    z: (start.z - current.z) * powerScale,
  }, trebuchetFireVelocityMax());

  const prevAngle = trebuchet.armAngle;
  trebuchet.armAngle = restArmAngleForTrebuchet();
  const shotStartPoint = loadTargetForTrebuchet(trebuchet);
  trebuchet.armAngle = prevAngle;
  loadTargetForTrebuchet(trebuchet);

  if (!shotStartPoint) {
    clearArcFields(trebuchet);
    return;
  }

  trebuchet.shotVelocity = shotVelocity;
  trebuchet.shotStartPoint = shotStartPoint;
  const physicsTimeScale = getConfig("physicsTimeScale");
  trebuchet.shotArcPoints = computeArcPoints({
    startPoint: shotStartPoint,
    velocity: shotVelocity,
    gravity: getConfig("gravity") * physicsTimeScale,
    damping: getConfig("missileLinearDamping") * physicsTimeScale,
    dotCount: getConfig("shotArcDotCount"),
    arcFraction: getConfig("shotArcFraction"),
    maxDuration: getConfig("shotArcMaxDuration"),
    groundY: getConfig("shotArcGroundY"),
  });

  const speed = Math.hypot(shotVelocity.x, shotVelocity.y, shotVelocity.z);
  trebuchet.powerRatio = Math.min(1, speed / trebuchetFireVelocityMax());
}

export function beginTrebuchetRelease(trebuchet) {
  const start = trebuchet.aimStart;
  const current = trebuchet.aimCurrent ?? start;
  if (!start || !current) return;

  const powerScale = getConfig("aimPowerScale");
  const shotDirectionX = trebuchet.player === 1 ? 1 : -1;
  const velocity = releaseVelocityForObject({ id: "missile" }, {
    x: Math.abs(start.x - current.x) * powerScale * shotDirectionX,
    y: (start.y - current.y) * powerScale,
    z: (start.z - current.z) * powerScale,
  }, trebuchetFireVelocityMax());

  trebuchet.fireState = ARM_STATE_RELEASING;
  trebuchet.pendingShot = {
    velocity,
    released: false,
    startArmAngle: trebuchet.armAngle ?? getConfig("trebuchetArmRestRotationZDegrees"),
  };
  trebuchet.releaseElapsedMs = 0;
  clearArcFields(trebuchet);
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
  clearArcFields(trebuchet);

  callHook(getActiveLevel()?.def?.hooks?.onMissileFired, getHookContext(), trebuchet, missile);

  return true;
}

export function releaseAimForClient(clientId) {
  for (const trebuchet of gameObjects.values()) {
    if (!isTrebuchetName(trebuchet.id)) continue;
    if (trebuchet.aimedBy !== clientId) continue;

    trebuchet.fireState = ARM_STATE_IDLE;
    trebuchet.armAngle = restArmAngleForTrebuchet();
    trebuchet.aimedBy = null;
    trebuchet.aimStart = null;
    trebuchet.aimCurrent = null;
    clearArcFields(trebuchet);
  }
}
