import { BARRAGE_CONFIG } from "../../public/config.js";
import { SERVER_CONFIG } from "../config.js";
import { clamp, clampVector } from "../math.js";

export const ARM_STATE_IDLE = "idle";
export const ARM_STATE_AIMING = "aiming";
export const ARM_STATE_RELEASING = "releasing";
export const ARM_STATE_RETURNING = "returning";

export function toWireObject(object) {
  return {
    id: object.id,
    x: object.x,
    y: object.y,
    z: object.z,
    rot: object.rot,
    vx: object.vx,
    vy: object.vy,
    vz: object.vz,
    ...(object.player != null ? { player: object.player } : {}),
    ...(object.loaded !== undefined ? { loaded: object.loaded } : {}),
    ...(object.loadedInto ? { loadedInto: object.loadedInto } : {}),
    ...(object.armAngle !== undefined ? { armAngle: object.armAngle, fireState: object.fireState } : {}),
    ...(object.hits !== undefined ? { hits: object.hits, maxHits: object.maxHits } : {}),
  };
}

export function isTrebuchetName(name) {
  return name.startsWith("trebuchets/");
}

export function isMissileName(name) {
  return name.startsWith("missiles/");
}

export function isKingName(name) {
  return name.startsWith("kings/");
}

export function restArmAngleForTrebuchet() {
  return BARRAGE_CONFIG.trebuchetArmRestRotationZDegrees ?? 15;
}

export function normalReleaseVelocityMax() {
  return BARRAGE_CONFIG.normalReleaseVelocityMax
    ?? BARRAGE_CONFIG.releaseVelocityMax
    ?? SERVER_CONFIG.releaseVelocityMax;
}

export function trebuchetFireVelocityMax() {
  return BARRAGE_CONFIG.trebuchetFireVelocityMax
    ?? SERVER_CONFIG.releaseVelocityMax;
}

export function releaseVelocityForObject(object, velocity = {}, maxVelocity = normalReleaseVelocityMax()) {
  const clamped = clampVector({
    x: Number(velocity.x ?? 0),
    y: Number(velocity.y ?? 0),
    z: Number(velocity.z ?? 0),
  }, maxVelocity);

  if (isTrebuchetName(object.id)) {
    return { x: clamped.x, y: 0, z: 0 };
  }

  return clamped;
}

export function constrainWorldBounds(object) {
  object.x = clamp(object.x, SERVER_CONFIG.worldMinX, SERVER_CONFIG.worldMaxX);
  object.z = clamp(object.z, SERVER_CONFIG.worldMinZ, SERVER_CONFIG.worldMaxZ);

  const floorY = SERVER_CONFIG.groundY + object.halfY - (object.offsetY ?? 0);
  if (object.y < floorY) {
    object.y = floorY;
    if (object.vy < 0) object.vy = 0;
  }

  if (object.x === SERVER_CONFIG.worldMinX && object.vx < 0) object.vx = 0;
  if (object.x === SERVER_CONFIG.worldMaxX && object.vx > 0) object.vx = 0;
  if (object.z === SERVER_CONFIG.worldMinZ && object.vz < 0) object.vz = 0;
  if (object.z === SERVER_CONFIG.worldMaxZ && object.vz > 0) object.vz = 0;
}

export function constrainedPointForObject(object, point, clientId = null) {
  if (!isTrebuchetName(object.id)) {
    let x = Number(point.x);
    if (clientId === 1) x = Math.min(x, 0);
    if (clientId === 2) x = Math.max(x, 0);
    return {
      x,
      y: Number(point.y ?? object.y),
      z: Number(point.z),
    };
  }

  const minX = object.player === 1
    ? BARRAGE_CONFIG.trebuchetLeftMinX
    : BARRAGE_CONFIG.trebuchetRightMinX;
  const maxX = object.player === 1
    ? BARRAGE_CONFIG.trebuchetLeftMaxX
    : BARRAGE_CONFIG.trebuchetRightMaxX;

  return {
    x: clamp(Number(point.x), minX, maxX),
    y: object.originY,
    z: object.originZ,
  };
}
