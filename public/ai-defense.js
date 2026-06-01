// ai-defense.js — king exposure detection and block selection for AI defense.

export const COVER_RADIUS    = 7;     // m — no covering block within this → king exposed
export const COVER_MIN_Y_ABOVE = 1.0; // block.y must exceed king.y + this to count as cover (king top ≈ king.y + 0.8)
export const STACK_X_RANGE   = 2;     // m — x range used to detect blocks above a candidate
export const LIFT_CLEARANCE  = 5;     // m above king y to lift block before carrying
export const PLACE_OFFSET    = 3;     // m inside king x where block is lowered
export const LOWER_SPEED_MS  = 0.005; // world units/ms the command position descends
export const SETTLE_SPEED    = 0.5;   // m/s — block is considered settled below this
export const DEFENSE_TIMEOUT = 5000;  // ms before giving up on any single defense state

function isBlock(id) {
  const n = id.toLowerCase();
  return n.includes("block") && !n.includes("frag");
}

/**
 * Returns true if the king has no covering block on its enemy-facing (inside) side.
 *
 * "Inside" means between the king and the centre of the field (x = 0):
 *   Player_1 (left side, ownLeft = true):  inside is to the right of the king (+x)
 *   Player_2 (right side, ownLeft = false): inside is to the left of the king (−x)
 */
export function isKingExposed(objects, king, ownLeft) {
  return !objects.some((o) => {
    if (!isBlock(o.id)) return false;
    const dx = o.x - king.x;
    const isInside = ownLeft ? dx > 0 : dx < 0;
    return isInside
      && Math.abs(dx) < COVER_RADIUS
      && o.y > king.y + COVER_MIN_Y_ABOVE;
  });
}

/**
 * Finds the best free block to move in front of the king:
 *   - Not already within COVER_RADIUS of the king
 *   - No other block within ±STACK_X_RANGE at a greater y (nothing on top)
 *   - Within the player's grab zone
 * Returns the nearest qualifying block to the king, or null if none found.
 */
export function findFreeBlock(objects, king, ownLeft, grabZoneLimit) {
  const candidates = objects.filter((o) => {
    if (!isBlock(o.id)) return false;
    if (Math.abs(o.x - king.x) < COVER_RADIUS) return false;

    const inZone = ownLeft ? o.x <= grabZoneLimit : o.x >= -grabZoneLimit;
    if (!inZone) return false;

    // Reject if any other block is directly above within ±STACK_X_RANGE
    const hasBlockAbove = objects.some(
      (b) => b.id !== o.id && isBlock(b.id)
          && Math.abs(b.x - o.x) <= STACK_X_RANGE
          && b.y > o.y,
    );
    return !hasBlockAbove;
  });

  if (!candidates.length) return null;

  // Nearest to king minimises drag distance
  return candidates.reduce((best, o) =>
    Math.abs(o.x - king.x) < Math.abs(best.x - king.x) ? o : best,
  );
}
