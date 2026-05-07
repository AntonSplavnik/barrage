import { BARRAGE_CONFIG } from "../public/config.js";

const NO_MANS_LAND_X = BARRAGE_CONFIG.noMansLandX ?? 5;

export function playerSide(playerId) {
  const num = parseInt(playerId?.split("_")[1], 10);
  if (!Number.isFinite(num)) return null;
  return num % 2 === 1 ? "left" : "right";
}

// Kings are never grabbable. Other entities are grabbable if within the player's zone at drag start.
export function canGrab(playerId, entity) {
  if (entity.id.toLowerCase().includes("king")) return false;
  const side = playerSide(playerId);
  return side ? isInPlayerZone(side, entity.x) : false;
}

// Right players (odd): x >= -limit. Left players (even): x <= +limit.
export function isInPlayerZone(side, x) {
  return side === "left" ? x <= NO_MANS_LAND_X : x >= -NO_MANS_LAND_X;
}

// The x boundary a player cannot drag past.
export function zoneLimitX(side) {
  return side === "left" ? NO_MANS_LAND_X : -NO_MANS_LAND_X;
}

// Returns the first king whose tilt angle exceeds the knockout threshold, or null.
export function checkKingKnockout(gameObjects) {
  const threshold = BARRAGE_CONFIG.kingKnockoutAngle ?? 75;
  for (const object of gameObjects.values()) {
    if (object.id.toLowerCase().includes("king") && Math.abs(object.rot) >= threshold) {
      return object;
    }
  }
  return null;
}
