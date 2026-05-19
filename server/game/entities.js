import { getConfig } from "../config.js";
import { clamp, clampVector } from "../math.js";

export const ARM_STATE_IDLE = "idle";
export const ARM_STATE_AIMING = "aiming";
export const ARM_STATE_RELEASING = "releasing";
export const ARM_STATE_RETURNING = "returning";

export function toWireObject(object, clientId) {
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
    ...(object.missileType ? { missileType: object.missileType } : {}),
    ...(object.trailing ? { trailing: true } : {}),
    ...(object.armAngle !== undefined ? { armAngle: object.armAngle, fireState: object.fireState } : {}),
    ...(object.fireState === ARM_STATE_AIMING && object.aimedBy === clientId
      ? { shotArcPoints: object.shotArcPoints, powerRatio: object.powerRatio }
      : {}),
    ...(object.hits !== undefined ? { hits: object.hits, maxHits: object.maxHits } : {}),
    ...(object.hitStage !== undefined ? { hitStage: object.hitStage } : {}),
    ...(!object.isFragment && object.fragmentTemplate ? { fragmentTemplate: object.fragmentTemplate } : {}),
    ...(object.isFragment ? { isFragment: true, pieceIndex: object.pieceIndex, fragmentTemplate: object.fragmentTemplate } : {}),
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

export function isBlockName(name) {
  return name.startsWith("blocks/");
}

export function isFragmentName(name) {
  return name.startsWith("blocks/") && name.includes("_frag_");
}

export function isGroundName(name) {
  return name === "ground" || name === "arena-col-Plane-ColVis";
}

export function restArmAngleForTrebuchet() {
  return getConfig("trebuchetArmRestRotationZDegrees");
}

export function normalReleaseVelocityMax() {
  return getConfig("normalReleaseVelocityMax");
}

export function trebuchetFireVelocityMax() {
  return getConfig("trebuchetFireVelocityMax");
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
  object.x = clamp(object.x, getConfig("worldMinX"), getConfig("worldMaxX"));
  object.z = clamp(object.z, getConfig("worldMinZ"), getConfig("worldMaxZ"));

  const floorY = getConfig("groundY") + object.halfY - (object.offsetY ?? 0);
  if (object.y < floorY) {
    object.y = floorY;
    if (object.vy < 0) object.vy = 0;
  }

  if (object.x === getConfig("worldMinX") && object.vx < 0) object.vx = 0;
  if (object.x === getConfig("worldMaxX") && object.vx > 0) object.vx = 0;
  if (object.z === getConfig("worldMinZ") && object.vz < 0) object.vz = 0;
  if (object.z === getConfig("worldMaxZ") && object.vz > 0) object.vz = 0;
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
    ? getConfig("trebuchetLeftMinX")
    : getConfig("trebuchetRightMinX");
  const maxX = object.player === 1
    ? getConfig("trebuchetLeftMaxX")
    : getConfig("trebuchetRightMaxX");

  return {
    x: clamp(Number(point.x), minX, maxX),
    y: object.originY,
    z: object.originZ,
  };
}
