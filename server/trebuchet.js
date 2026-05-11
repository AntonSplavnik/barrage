import {
  clamp,
  isPullAwayFromCenter,
  isMissileName,
  isTrebuchetName,
  releaseVelocityForObject,
  restArmAngleForTrebuchet,
  sideSignForTrebuchet,
  trebuchetFireVelocityMax,
} from "./utils.js";

export function loadTargetForTrebuchet(trebuchet, { loadTargets }) {
  const target = loadTargets.get(trebuchet.id) ?? loadTargets.get("default") ?? null;
  if (!target) return null;

  if (target.targetNode && target.rootNode) {
    target.rootNode.position.x = trebuchet.x;
    target.rootNode.position.y = trebuchet.y;
    target.rootNode.position.z = trebuchet.z;

    if (target.armNode && typeof trebuchet.armAngle === "number") {
      target.armNode.rotationQuaternion = null;
      target.armNode.rotation.z = sideSignForTrebuchet(trebuchet.id) * (trebuchet.armAngle * Math.PI) / 180;
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

export function maybeLoadMissile(missile, {
  armStateIdle,
  config,
  gameObjects,
  loadTargetForTrebuchet,
  setPhysicsBodyTrigger,
}) {
  if (!isMissileName(missile.id)) return false;

  for (const trebuchet of gameObjects.values()) {
    if (!isTrebuchetName(trebuchet.id) || trebuchet.loaded) continue;

    const range = config.missileLoadRange ?? 6;
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
    missile.usedToFragment = false;
    missile.lastBlockHitTick = null;
    setPhysicsBodyTrigger(missile, true);
    trebuchet.loaded = true;
    trebuchet.loadedMissileId = missile.id;
    trebuchet.fireState = armStateIdle;
    trebuchet.armAngle = restArmAngleForTrebuchet(trebuchet);
    return true;
  }

  return false;
}

export function updateTrebuchetAim(trebuchet, point, { config }) {
  const start = trebuchet.aimStart;
  if (!start) return;

  const requested = {
    x: Number(point.x),
    y: Number(point.y ?? start.y),
    z: Number(point.z ?? start.z),
  };
  if (!isPullAwayFromCenter(requested, start)) {
    trebuchet.aimCurrent = start;
    trebuchet.armAngle = restArmAngleForTrebuchet(trebuchet);
    return;
  }

  const pullX = requested.x - start.x;
  const pullY = requested.y - start.y;
  const pullDistance = Math.hypot(pullX, pullY);
  const maxPullDistance = config.aimMaxPullDistance ?? 6;
  const clampedDistance = clamp(pullDistance, 0, maxPullDistance);
  const pullScale = pullDistance > 0.0001 ? clampedDistance / pullDistance : 0;
  const current = {
    x: start.x + pullX * pullScale,
    y: start.y + pullY * pullScale,
    z: requested.z,
  };
  trebuchet.aimCurrent = current;

  const pullRatio = clampedDistance / Math.max(0.001, maxPullDistance);
  const maxExtra = config.trebuchetArmPullbackMaxDegrees
    ?? config.aimArmMaxExtraDegrees
    ?? 45;
  const restAngle = Math.abs(config.trebuchetArmRestRotationZDegrees ?? 15);

  trebuchet.armAngle = restAngle + pullRatio * maxExtra;
}

export function beginTrebuchetRelease(trebuchet, {
  armStateIdle,
  armStateReleasing,
  broadcastSoundEffect,
  config,
}) {
  const start = trebuchet.aimStart;
  const current = trebuchet.aimCurrent ?? start;
  if (!start || !current) return;

  if (!isPullAwayFromCenter(current, start)) {
    trebuchet.fireState = armStateIdle;
    trebuchet.aimedBy = null;
    trebuchet.aimStart = null;
    trebuchet.aimCurrent = null;
    trebuchet.pendingShot = null;
    trebuchet.releaseElapsedMs = 0;
    trebuchet.armAngle = restArmAngleForTrebuchet(trebuchet);
    return;
  }

  const powerScale = config.aimPowerScale ?? 8;
  const shotDirectionX = sideSignForTrebuchet(trebuchet.id);
  const velocity = releaseVelocityForObject({ id: "missile" }, {
    x: Math.abs(start.x - current.x) * powerScale * shotDirectionX,
    y: (start.y - current.y) * powerScale,
    z: (start.z - current.z) * powerScale,
  }, trebuchetFireVelocityMax());

  trebuchet.fireState = armStateReleasing;
  trebuchet.pendingShot = {
    velocity,
    released: false,
    startArmAngle: trebuchet.armAngle ?? (config.trebuchetArmRestRotationZDegrees ?? 15),
  };
  trebuchet.releaseElapsedMs = 0;

  broadcastSoundEffect("trebuchet_release", trebuchet);
}
