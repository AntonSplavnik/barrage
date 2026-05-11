import { Quaternion } from "@babylonjs/core/Maths/math.vector.js";
import { SERVER_CONFIG } from "../config/server.js";
import { BARRAGE_CONFIG } from "../public/config.js";

export function childRole(name) {
  if (name.includes("ColVis")) return "ColVis";
  if (name.includes("Visual") || name.includes("Vis")) return "Vis";
  if (name.includes("Collider") || name.includes("Col")) return "Col";
  return null;
}

export function isDynamicName(name) {
  const lowerName = name.toLowerCase();
  return lowerName.includes("block")
    || lowerName.includes("trebuche")
    || lowerName.includes("missile")
    || lowerName.includes("king");
}

export function isTrebuchetName(name) {
  return name.toLowerCase().includes("trebuche");
}

export function isTrebuchetArmName(name) {
  const lowerName = name.toLowerCase();
  return lowerName.includes("trebuche") && lowerName.includes("arm");
}

export function isMissileName(name) {
  return name.toLowerCase().includes("missile");
}

export function isKingName(name) {
  return name.toLowerCase().includes("king");
}

export function isBlockName(name) {
  const lowerName = name.toLowerCase();
  return lowerName.includes("block") && !lowerName.includes("frag");
}

export function isGroundName(name) {
  return name.toLowerCase().includes("ground");
}

export function isLeftSideTrebuchetName(name) {
  const lowerName = name.toLowerCase();
  return lowerName.includes("p1") || lowerName.includes("left") || lowerName.includes("1");
}

export function isLeftSideKingName(name) {
  const lowerName = name.toLowerCase();
  return lowerName.includes("kingl")
    || lowerName.includes("left")
    || lowerName.includes("p1")
    || lowerName.endsWith("l");
}

export function sideSignForTrebuchet(name) {
  return isLeftSideTrebuchetName(name) ? 1 : -1;
}

export function restArmAngleForTrebuchet() {
  return BARRAGE_CONFIG.trebuchetArmRestRotationZDegrees ?? 15;
}

export function isPullAwayFromCenter(point, origin) {
  if (Math.sign(point.x || 0) !== Math.sign(origin.x || 0)) return false;
  return Math.abs(point.x) > Math.abs(origin.x);
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function clampVector(vector, maxMagnitude) {
  const magnitude = Math.hypot(vector.x, vector.y, vector.z);
  if (magnitude <= maxMagnitude || magnitude === 0) return vector;

  const scale = maxMagnitude / magnitude;
  return {
    x: vector.x * scale,
    y: vector.y * scale,
    z: vector.z * scale,
  };
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function shortestAngleDeltaDegrees(from, to) {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

export function lerpAngleDegrees(from, to, t) {
  return from + shortestAngleDeltaDegrees(from, to) * t;
}

export function protocolToBabylonRotation(rotDegrees) {
  return -(rotDegrees * Math.PI) / 180;
}

export function babylonToProtocolRotationZ(radians) {
  return -(radians * 180) / Math.PI;
}

export function rotationQuaternionForObject(object) {
  return Quaternion.FromEulerAngles(0, 0, protocolToBabylonRotation(object.rot ?? 0));
}

export function clampAngularVelocity(value) {
  const max = BARRAGE_CONFIG.maxAngularVelocity ?? 540;
  return clamp(value, -max, max);
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
    return {
      x: clamped.x,
      y: 0,
      z: 0,
    };
  }

  return clamped;
}
