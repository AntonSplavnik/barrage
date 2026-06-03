// AiPlayer — local AI opponent running in the host browser.
// Posts the same input messages the human client sends, driven by a state machine.

import {
  isKingExposed, findFreeBlock,
  LIFT_CLEARANCE, PLACE_OFFSET, LOWER_SPEED_MS, SETTLE_SPEED, DEFENSE_TIMEOUT,
} from "./ai-defense.js";
import { BARRAGE_CONFIG } from "./config.js";
import {
  dampedFlightDurationToGround,
  dampedPosition,
} from "./trebuche-shot-arc-prediction.js";

const LOAD_TARGET_OFFSET_Y  = 3.5;
const DRAG_UNITS_PER_MS     = 0.02;  // at speed=1.0
const AIM_UNITS_PER_MS      = 0.01;
const MAX_JITTER_DEG        = 50;    // accuracy 0.8 → ±(0.2×50)=±10°
const WAIT_LOADED_TIMEOUT   = 3500;  // ms before giving up on a load
const IN_FLIGHT_SPEED       = 2;     // m/s — missiles above this ignored
const NO_MANS_LAND          = 5;
const GRAB_TOLERANCE        = 1.5;
const GRAB_ZONE             = NO_MANS_LAND + GRAB_TOLERANCE; // 6.5
const V_MAX                 = 40;    // trebuchetFireVelocityMax (config.js)
const MAX_PULL              = 6;     // aimMaxPullDistance
const GRAVITY               = -9.81;
const DAMPING               = 0.15;  // missileLinearDamping
const MAX_TRAJECTORY_DURATION = 25;
const PULL_SCALE_MIN        = 0.5;   // minimum pull (limits minimum power)
const ADJUST_DEAD_ZONE      = 3;     // units — ignore errors smaller than this
const DRAG_ZENITH_Y         = 7;    // world-space y of arc apex when picking up a missile
const DEFENSE_INITIAL_LIFT_Y = 2;    // m — always lift a selected defense block before carrying/lowering
const KING_CLEAR_RADIUS     = 4;     // m — trajectory must stay this far from own king
const KING_CLEAR_ANGLE_STEP = 5;     // degrees to add each retry when own king is in the way
const OWN_BLOCK_CLEAR_RADIUS = 2.8;  // m — conservative block hit radius in the 2D aim plane
const OWN_BLOCK_CLEAR_ANGLE_STEP = 5;
const DEFAULT_AVOID_OWN_BLOCKS = 2 / 3; // fraction of shots that try to clear own blocks
const MIN_AIM_PULL_RATIO    = 0.25;
const PULL_SEARCH_STEP      = 0.4;   // m
const ANGLE_SEARCH_STEP_DEG = 2;
const SHOT_CANDIDATE_LIMIT  = 18;    // expensive collision checks run only on this shortlist
const OWN_BLOCK_HIT_PENALTY = 40;
const OWN_KING_HIT_PENALTY  = 1000;
const MIN_SHOT_ANGLE_DEG    = 10;
const MAX_SHOT_ANGLE_DEG    = 75;
const INITIAL_DELAY_MS          = 2000;
const LEVEL_DIFFICULTY_BUMP     = 0.035; // speed + accuracy increase per round

const STATE = {
  IDLE:           "IDLE",
  PAUSE:          "PAUSE",
  FIND_MISSILE:   "FIND_MISSILE",
  DRAG_TO_LOAD:   "DRAG_TO_LOAD",
  WAIT_LOADED:    "WAIT_LOADED",
  AIM_START:      "AIM_START",
  AIM_PULL:       "AIM_PULL",
  FIRE:           "FIRE",
  CHECK_DEFENSE:  "CHECK_DEFENSE",
  GRAB_BLOCK:     "GRAB_BLOCK",
  LIFT_BLOCK:     "LIFT_BLOCK",
  CARRY_BLOCK:    "CARRY_BLOCK",
  LOWER_BLOCK:    "LOWER_BLOCK",
};

// ---------------------------------------------------------------------------
// Damped ballistic solver — matches Havok missile physics.
// Returns the angle (degrees, 10–75) that gets closest to (targetX, targetY).
// sideSign: +1 fires in +x direction, −1 fires in −x direction.
// ---------------------------------------------------------------------------
function trajectoryGravity() {
  return BARRAGE_CONFIG.gravity ?? GRAVITY;
}

function trajectoryDamping() {
  return Math.max(0, BARRAGE_CONFIG.shotArcLinearDamping ?? BARRAGE_CONFIG.missileLinearDamping ?? DAMPING);
}

function trajectoryGroundY() {
  return BARRAGE_CONFIG.shotArcGroundY ?? 0;
}

function trajectoryPosition(fromX, fromY, vx, vy, t) {
  return dampedPosition(
    { x: fromX, y: fromY, z: 0 },
    { x: vx, y: vy, z: 0 },
    trajectoryGravity(),
    trajectoryDamping(),
    t,
  );
}

function trajectoryDuration(fromX, fromY, vx, vy) {
  return dampedFlightDurationToGround(
    { x: fromX, y: fromY, z: 0 },
    { x: vx, y: vy, z: 0 },
    trajectoryGravity(),
    trajectoryDamping(),
    trajectoryGroundY(),
    MAX_TRAJECTORY_DURATION,
  );
}

function trajectoryYAtX(fromX, fromY, vx, vy, targetX) {
  const dx = targetX - fromX;
  if (Math.sign(dx) !== Math.sign(vx) || Math.abs(vx) < 0.0001) return null;

  const damping = trajectoryDamping();
  let t = 0;
  if (damping <= 0.0001) {
    t = dx / vx;
  } else {
    const velocityScale = dx / vx;
    const decay = 1 - damping * velocityScale;
    if (decay <= 0 || decay > 1) return null;
    t = -Math.log(decay) / damping;
  }

  if (!Number.isFinite(t) || t < 0 || t > MAX_TRAJECTORY_DURATION) return null;
  return trajectoryPosition(fromX, fromY, vx, vy, t).y;
}

function shotVelocityForPull(angleDeg, pull, sideSign, powerScale, maxVelocity) {
  const rad = angleDeg * Math.PI / 180;
  const speed = Math.min(pull * powerScale, maxVelocity);
  return {
    vx: speed * Math.cos(rad) * sideSign,
    vy: speed * Math.sin(rad),
    speed,
  };
}

function findBestShot(fromX, fromY, target, sideSign, maxPull, powerScale, maxVelocity, {
  avoidOwnBlocks = false,
  ownBlocks = [],
  ownKing = null,
} = {}) {
  const candidates = [];
  let best = {
    angleDeg: 45,
    pull: maxPull,
    speed: Math.min(maxPull * powerScale, maxVelocity),
    score: Infinity,
    targetError: Infinity,
    ownBlockHit: null,
    ownKingThreat: false,
  };
  const minPull = Math.max(0.5, maxPull * MIN_AIM_PULL_RATIO);

  for (let pull = minPull; pull <= maxPull + 0.0001; pull += PULL_SEARCH_STEP) {
    for (let angleDeg = MIN_SHOT_ANGLE_DEG; angleDeg <= MAX_SHOT_ANGLE_DEG; angleDeg += ANGLE_SEARCH_STEP_DEG) {
      const { vx, vy, speed } = shotVelocityForPull(angleDeg, pull, sideSign, powerScale, maxVelocity);
      const yAtTarget = trajectoryYAtX(fromX, fromY, vx, vy, target.x);
      if (yAtTarget === null) continue;

      const targetError = Math.abs(yAtTarget - target.y);
      candidates.push({ angleDeg, pull, speed, vx, vy, targetError });
    }
  }

  candidates.sort((a, b) => a.targetError - b.targetError);

  for (const candidate of candidates.slice(0, SHOT_CANDIDATE_LIMIT)) {
    const ownKingThreat = ownKing
      ? trajectoryThreatensKing(fromX, fromY, candidate.vx, candidate.vy, ownKing.x, ownKing.y)
      : false;
    const ownBlockHit = avoidOwnBlocks
      ? trajectoryThreatensBlocks(fromX, fromY, candidate.vx, candidate.vy, ownBlocks)
      : null;
    const score = candidate.targetError
      + (ownBlockHit ? OWN_BLOCK_HIT_PENALTY : 0)
      + (ownKingThreat ? OWN_KING_HIT_PENALTY : 0);

    if (score < best.score) {
      best = {
        angleDeg: candidate.angleDeg,
        pull: candidate.pull,
        speed: candidate.speed,
        score,
        targetError: candidate.targetError,
        ownBlockHit,
        ownKingThreat,
      };
    }
  }

  return best;
}

function pointSegmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 <= 0.0001) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Returns true if the trajectory from (fromX,fromY) at (vx,vy) passes within
// KING_CLEAR_RADIUS of (kingX, kingY) before hitting the ground. Segment
// distance catches near misses between simulation samples.
function trajectoryPassesNearPoint(fromX, fromY, vx, vy, pointX, pointY, radius) {
  const step = 1 / 60;
  const duration = trajectoryDuration(fromX, fromY, vx, vy);
  let prev = { x: fromX, y: fromY };
  for (let t = step; t <= duration; t += step) {
    const p = trajectoryPosition(fromX, fromY, vx, vy, t);
    if (pointSegmentDistance(pointX, pointY, prev.x, prev.y, p.x, p.y) <= radius) return true;
    prev = p;
  }
  return false;
}

function trajectoryThreatensKing(fromX, fromY, vx, vy, kingX, kingY) {
  return trajectoryPassesNearPoint(fromX, fromY, vx, vy, kingX, kingY, KING_CLEAR_RADIUS);
}

function trajectoryThreatensKingAtAngle(fromX, fromY, angleDeg, sideSign, speed, king) {
  const rad = angleDeg * Math.PI / 180;
  const vx  = speed * Math.cos(rad) * sideSign;
  const vy  = speed * Math.sin(rad);
  return trajectoryThreatensKing(fromX, fromY, vx, vy, king.x, king.y);
}

function raiseAngleToClearKing(fromX, fromY, angleDeg, sideSign, speed, king) {
  let safeAngle = Math.max(MIN_SHOT_ANGLE_DEG, Math.min(MAX_SHOT_ANGLE_DEG, angleDeg));
  let attempts = 0;

  while (safeAngle < MAX_SHOT_ANGLE_DEG
      && trajectoryThreatensKingAtAngle(fromX, fromY, safeAngle, sideSign, speed, king)) {
    safeAngle = Math.min(MAX_SHOT_ANGLE_DEG, safeAngle + KING_CLEAR_ANGLE_STEP);
    attempts++;
  }

  return {
    angle: safeAngle,
    attempts,
    cleared: !trajectoryThreatensKingAtAngle(fromX, fromY, safeAngle, sideSign, speed, king),
  };
}

function isBlockId(id) {
  const n = id.toLowerCase();
  return n.includes("block") && !n.includes("frag");
}

function trajectoryThreatensBlocksAtAngle(fromX, fromY, angleDeg, sideSign, speed, blocks) {
  const rad = angleDeg * Math.PI / 180;
  const vx  = speed * Math.cos(rad) * sideSign;
  const vy  = speed * Math.sin(rad);
  return blocks.find((block) =>
    trajectoryPassesNearPoint(fromX, fromY, vx, vy, block.x, block.y, OWN_BLOCK_CLEAR_RADIUS),
  ) ?? null;
}

function trajectoryThreatensBlocks(fromX, fromY, vx, vy, blocks) {
  return blocks.find((block) =>
    trajectoryPassesNearPoint(fromX, fromY, vx, vy, block.x, block.y, OWN_BLOCK_CLEAR_RADIUS),
  ) ?? null;
}

function raiseAngleToClearBlocks(fromX, fromY, angleDeg, sideSign, speed, blocks) {
  let safeAngle = Math.max(MIN_SHOT_ANGLE_DEG, Math.min(MAX_SHOT_ANGLE_DEG, angleDeg));
  let attempts = 0;
  let blockingBlock = trajectoryThreatensBlocksAtAngle(fromX, fromY, safeAngle, sideSign, speed, blocks);

  while (safeAngle < MAX_SHOT_ANGLE_DEG && blockingBlock) {
    safeAngle = Math.min(MAX_SHOT_ANGLE_DEG, safeAngle + OWN_BLOCK_CLEAR_ANGLE_STEP);
    attempts++;
    blockingBlock = trajectoryThreatensBlocksAtAngle(fromX, fromY, safeAngle, sideSign, speed, blocks);
  }

  return {
    angle: safeAngle,
    attempts,
    cleared: !blockingBlock,
    blockingBlock,
  };
}

// ---------------------------------------------------------------------------

export class AiPlayer {
  constructor(postToWorker, config, role) {
    this._post   = postToWorker;
    this._config = config;
    this._role   = role;        // "Player_1" | "Player_2"
    this._state  = STATE.IDLE;
    this._lastTick = null;

    this._objects         = null;
    this._trebuchet       = null;
    this._targetMissile   = null;
    this._loadedMissile   = null;
    this._dragCurrent     = null;
    this._aimCurrent      = null;
    this._aimPullTarget   = null;
    this._pauseRemaining  = 0;
    this._waitLoadedMs       = 0;
    this._useOutside         = false;
    this._pullScale          = 1.0;
    this._firedMissileId     = null;
    this._lastKnownMissileX  = null;
    this._dragStart          = null;
    this._dragT              = 0;
    this._roundNumber        = 1;
    // Defense
    this._shotCount          = 0;
    this._doDefenseCheck     = false;
    this._defenseBlockId     = null;
    this._defenseMs          = 0;
    this._liftTargetY        = 0;
    this._carryTargetX       = 0;
    this._defenseCmdY        = 0;
  }

  onState(objects, roundNumber = 1) {
    this._objects = objects;
    this._roundNumber = roundNumber;
    const trebId = this._role === "Player_1" ? "trebuche-left" : "trebuche-right";
    this._trebuchet     = objects.find((o) => o.id === trebId) ?? null;
    this._loadedMissile = objects.find((o) => o.loadedInto === trebId) ?? null;

    if (this._firedMissileId) {
      const m = objects.find((o) => o.id === this._firedMissileId);
      if (m) {
        this._lastKnownMissileX = m.x;
        const speed = Math.hypot(m.vx ?? 0, m.vy ?? 0, m.vz ?? 0);
        if (m.y < 1.5 && speed < 1.5) {
          // Missile settled on the ground
          this._adjustPullScale(m.x);
          this._firedMissileId = null;
        }
      } else if (this._lastKnownMissileX !== null) {
        // Missile disappeared (bomb exploded mid-air) — use last known x
        this._adjustPullScale(this._lastKnownMissileX);
        this._firedMissileId    = null;
        this._lastKnownMissileX = null;
      }
    }
  }

  start() {
    this._pauseRemaining = INITIAL_DELAY_MS;
    this._state = STATE.PAUSE;
    this._lastTick = null;
  }

  stop() {
    this._state = STATE.IDLE;
    this._firedMissileId    = null;
    this._lastKnownMissileX = null;
    this._aimPullTarget     = null;
  }

  reset() {
    this._pauseRemaining    = INITIAL_DELAY_MS;
    this._state             = STATE.PAUSE;
    this._targetMissile     = null;
    this._loadedMissile     = null;
    this._dragCurrent       = null;
    this._aimCurrent        = null;
    this._aimPullTarget     = null;
    this._waitLoadedMs      = 0;
    this._firedMissileId    = null;
    this._lastKnownMissileX = null;
    this._dragStart         = null;
    this._dragT             = 0;
    this._shotCount         = 0;
    this._doDefenseCheck    = false;
    this._defenseBlockId    = null;
    this._defenseMs         = 0;
    this._lastTick          = null;
    // _pullScale intentionally kept — systematic physics error persists across rounds
  }

  tick(now) {
    if (this._state === STATE.IDLE) return;
    const dt = this._lastTick !== null ? now - this._lastTick : 16;
    this._lastTick = now;
    this._step(dt);
  }

  _effectiveSpeed() {
    const bonus = (this._roundNumber - 1) * LEVEL_DIFFICULTY_BUMP;
    return Math.min(0.95, this._config.speed + bonus);
  }

  _effectiveAccuracy() {
    const bonus = (this._roundNumber - 1) * LEVEL_DIFFICULTY_BUMP;
    return Math.min(0.95, this._config.accuracy + bonus);
  }

  _step(dt) {
    // Defense states are handled by a separate method to keep _step focused
    if (this._state === STATE.CHECK_DEFENSE
     || this._state === STATE.GRAB_BLOCK
     || this._state === STATE.LIFT_BLOCK
     || this._state === STATE.CARRY_BLOCK
     || this._state === STATE.LOWER_BLOCK) {
      this._stepDefense(dt);
      return;
    }

    const speed = this._effectiveSpeed();

    switch (this._state) {

      case STATE.PAUSE: {
        this._pauseRemaining -= dt;
        if (this._pauseRemaining <= 0) {
          this._state = this._doDefenseCheck ? STATE.CHECK_DEFENSE : STATE.FIND_MISSILE;
          this._doDefenseCheck = false;
        }
        break;
      }

      case STATE.FIND_MISSILE: {
        if (!this._objects || !this._trebuchet) return;
        if (this._trebuchet.loaded || this._loadedMissile) {
          this._state = STATE.AIM_START;
          return;
        }
        const missile = this._pickMissile(this._useOutside)
                     ?? this._pickMissile(!this._useOutside);
        if (!missile) {
          if (this._canBuildDefense()) {
            this._state = STATE.CHECK_DEFENSE;
          }
          return;
        }
        this._targetMissile = missile;
        this._dragStart = { x: missile.x, y: missile.y, z: missile.z };
        this._dragT     = 0;
        this._post({ type: "input", action: "dragStart",
          entityId: missile.id,
          point:    { x: missile.x, y: missile.y, z: missile.z },
        });
        this._state = STATE.DRAG_TO_LOAD;
        break;
      }

      case STATE.DRAG_TO_LOAD: {
        if (!this._trebuchet || !this._targetMissile || !this._dragStart) {
          this._state = STATE.FIND_MISSILE; return;
        }
        const treb    = this._trebuchet;
        const targetX = treb.x;
        const targetY = treb.y + LOAD_TARGET_OFFSET_Y;
        const targetZ = treb.z;
        const startX  = this._dragStart.x;
        const startY  = this._dragStart.y;

        // Parabola: y at t=0 is startY, y at t=0.5 is zenith, y at t=1 is targetY
        const zenith  = Math.max(this._config.dragZenithY ?? DRAG_ZENITH_Y, startY + 1, targetY + 1);
        const pa      = -4 * zenith + 2 * (startY + targetY);
        const pb      = 4 * zenith - 3 * startY - targetY;

        const hDist = Math.abs(targetX - startX);
        if (hDist > 0.01) {
          // Advance t by horizontal speed
          this._dragT = Math.min(1, this._dragT + (DRAG_UNITS_PER_MS * speed * dt) / hDist);
        } else {
          this._dragT = 1;
        }

        const t = this._dragT;
        const x = startX + t * (targetX - startX);
        const y = pa * t * t + pb * t + startY;

        if (t >= 1) {
          this._post({ type: "input", action: "dragMove",
            entityId: this._targetMissile.id,
            point:    { x: targetX, y: targetY, z: targetZ },
          });
          this._post({ type: "input", action: "dragEnd",
            entityId: this._targetMissile.id,
            point:    { x: targetX, y: targetY, z: targetZ },
          });
          this._waitLoadedMs = 0;
          this._state = STATE.WAIT_LOADED;
        } else {
          this._post({ type: "input", action: "dragMove",
            entityId: this._targetMissile.id,
            point:    { x, y, z: targetZ },
          });
        }
        break;
      }

      case STATE.WAIT_LOADED: {
        this._waitLoadedMs += dt;
        if (this._waitLoadedMs > WAIT_LOADED_TIMEOUT) {
          this._targetMissile = null;
          this._waitLoadedMs  = 0;
          this._state = STATE.FIND_MISSILE;
          return;
        }
        if (!this._trebuchet) return;
        if (this._trebuchet.loaded || this._loadedMissile) {
          this._targetMissile = null;
          this._state = STATE.AIM_START;
        }
        break;
      }

      case STATE.AIM_START: {
        if (!this._trebuchet) return;
        const loaded = this._loadedMissile;
        if (!loaded) { this._state = STATE.FIND_MISSILE; return; }
        const treb = this._trebuchet;
        const ax = treb.x;
        const ay = treb.y + LOAD_TARGET_OFFSET_Y;
        this._aimCurrent = { x: ax, y: ay, z: treb.z };
        this._aimPullTarget = this._calcPullTarget(treb);
        this._post({ type: "input", action: "aimStart",
          entityId: loaded.id,
          point:    { x: ax, y: ay, z: treb.z },
        });
        this._state = STATE.AIM_PULL;
        break;
      }

      case STATE.AIM_PULL: {
        if (!this._trebuchet || !this._loadedMissile) {
          this._aimPullTarget = null;
          this._state = STATE.FIND_MISSILE;
          return;
        }
        const treb = this._trebuchet;
        const pull = this._aimPullTarget ?? this._calcPullTarget(treb);
        this._aimPullTarget = pull;
        const maxMove = AIM_UNITS_PER_MS * speed * dt;
        const dx = pull.x - this._aimCurrent.x;
        const dy = pull.y - this._aimCurrent.y;
        const dist = Math.hypot(dx, dy);

        if (dist <= maxMove) {
          this._aimCurrent = { x: pull.x, y: pull.y, z: treb.z };
          this._post({ type: "input", action: "aimMove",
            entityId: this._loadedMissile.id,
            point:    { x: pull.x, y: pull.y, z: treb.z },
          });
          this._state = STATE.FIRE;
        } else {
          const nx = this._aimCurrent.x + (dx / dist) * maxMove;
          const ny = this._aimCurrent.y + (dy / dist) * maxMove;
          this._aimCurrent = { x: nx, y: ny, z: treb.z };
          this._post({ type: "input", action: "aimMove",
            entityId: this._loadedMissile.id,
            point:    { x: nx, y: ny, z: treb.z },
          });
        }
        break;
      }

      case STATE.FIRE: {
        if (!this._trebuchet || !this._loadedMissile || !this._aimCurrent) {
          this._state = STATE.FIND_MISSILE; return;
        }
        this._firedMissileId    = this._loadedMissile.id;
        this._lastKnownMissileX = this._loadedMissile.x;
        this._shotCount++;
        if (this._shotCount % 2 === 0) this._doDefenseCheck = true;
        this._post({ type: "input", action: "aimRelease",
          entityId: this._loadedMissile.id,
          point:    { x: this._aimCurrent.x, y: this._aimCurrent.y, z: this._trebuchet.z },
        });
        this._aimCurrent = null;
        this._aimPullTarget = null;
        this._useOutside = !this._useOutside;
        this._pauseRemaining = this._config.pauseMs ?? 1000;
        this._state = STATE.PAUSE;
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Defense state handlers
  // ---------------------------------------------------------------------------

  _abandonDefense() {
    const block = this._objects?.find((o) => o.id === this._defenseBlockId);
    if (block) {
      this._post({ type: "input", action: "dragEnd",
        entityId: block.id,
        point: { x: block.x, y: block.y, z: block.z },
      });
    }
    this._defenseBlockId = null;
    this._state = STATE.FIND_MISSILE;
  }

  _stepDefense(dt) {
    const ownLeft = this._role === "Player_1";

    switch (this._state) {

      case STATE.CHECK_DEFENSE: {
        const ownKing = this._findOwnKing();
        if (!ownKing || !this._objects) { this._state = STATE.FIND_MISSILE; return; }
        if (!isKingExposed(this._objects, ownKing, ownLeft)) {
          this._state = STATE.FIND_MISSILE;
          return;
        }
        const block = findFreeBlock(this._objects, ownKing, ownLeft, GRAB_ZONE);
        if (!block) { this._state = STATE.FIND_MISSILE; return; }
        this._defenseBlockId = block.id;
        this._liftTargetY    = Math.max(ownKing.y + LIFT_CLEARANCE, block.y + DEFENSE_INITIAL_LIFT_Y);
        this._carryTargetX   = ownKing.x + (ownLeft ? PLACE_OFFSET : -PLACE_OFFSET);
        this._defenseMs      = 0;
        this._state = STATE.GRAB_BLOCK;
        break;
      }

      case STATE.GRAB_BLOCK: {
        const block = this._objects?.find((o) => o.id === this._defenseBlockId);
        if (!block) { this._state = STATE.FIND_MISSILE; return; }
        this._post({ type: "input", action: "dragStart",
          entityId: block.id,
          point: { x: block.x, y: block.y, z: block.z },
        });
        this._defenseMs = 0;
        this._state = STATE.LIFT_BLOCK;
        break;
      }

      case STATE.LIFT_BLOCK: {
        this._defenseMs += dt;
        const block = this._objects?.find((o) => o.id === this._defenseBlockId);
        if (!block || this._defenseMs > DEFENSE_TIMEOUT) { this._abandonDefense(); return; }
        this._post({ type: "input", action: "dragMove",
          entityId: block.id,
          point: { x: block.x, y: this._liftTargetY, z: block.z },
        });
        if (block.y >= this._liftTargetY - 1) {
          this._defenseMs = 0;
          this._state = STATE.CARRY_BLOCK;
        }
        break;
      }

      case STATE.CARRY_BLOCK: {
        this._defenseMs += dt;
        const block = this._objects?.find((o) => o.id === this._defenseBlockId);
        if (!block || this._defenseMs > DEFENSE_TIMEOUT) { this._abandonDefense(); return; }
        this._post({ type: "input", action: "dragMove",
          entityId: block.id,
          point: { x: this._carryTargetX, y: this._liftTargetY, z: block.z },
        });
        if (Math.abs(block.x - this._carryTargetX) < 1) {
          this._defenseMs  = 0;
          this._defenseCmdY = this._liftTargetY;
          this._state = STATE.LOWER_BLOCK;
        }
        break;
      }

      case STATE.LOWER_BLOCK: {
        this._defenseMs += dt;
        const block = this._objects?.find((o) => o.id === this._defenseBlockId);
        if (!block || this._defenseMs > DEFENSE_TIMEOUT) { this._abandonDefense(); return; }
        const speed = Math.hypot(block.vx ?? 0, block.vy ?? 0);
        if (speed < SETTLE_SPEED && this._defenseMs > 800) {
          this._post({ type: "input", action: "dragEnd",
            entityId: block.id,
            point: { x: block.x, y: block.y, z: block.z },
          });
          this._defenseBlockId = null;
          this._state = STATE.FIND_MISSILE;
          return;
        }
        this._defenseCmdY = Math.max(0, this._defenseCmdY - LOWER_SPEED_MS * dt);
        this._post({ type: "input", action: "dragMove",
          entityId: block.id,
          point: { x: this._carryTargetX, y: this._defenseCmdY, z: block.z },
        });
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Missile picking: inside = between trebuchet and centre; outside = beyond trebuchet (bombs).
  // Only at-rest missiles within the player's grab zone.
  // ---------------------------------------------------------------------------
  _pickMissile(outside) {
    if (!this._objects || !this._trebuchet) return null;
    const treb    = this._trebuchet;
    const ownLeft = this._role === "Player_1";

    const candidates = this._objects.filter((o) => {
      if (!o.id.toLowerCase().includes("missile")) return false;
      if (o.loadedInto) return false;
      if (Math.hypot(o.vx ?? 0, o.vy ?? 0, o.vz ?? 0) > IN_FLIGHT_SPEED) return false;
      const inZone = ownLeft ? o.x <= GRAB_ZONE : o.x >= -GRAB_ZONE;
      if (!inZone) return false;
      return outside
        ? (ownLeft ? o.x < treb.x : o.x > treb.x)
        : (ownLeft ? o.x > treb.x : o.x < treb.x);
    });

    if (candidates.length === 0) return null;
    return candidates.reduce((best, o) => (o.y > best.y ? o : best));
  }

  _canBuildDefense() {
    if (!this._objects) return false;
    const ownLeft = this._role === "Player_1";
    const ownKing = this._findOwnKing();
    if (!ownKing) return false;
    if (!isKingExposed(this._objects, ownKing, ownLeft)) return false;
    return Boolean(findFreeBlock(this._objects, ownKing, ownLeft, GRAB_ZONE));
  }

  // ---------------------------------------------------------------------------
  // Pull target: uses damped ballistic solver + adaptive angle correction + jitter.
  // ---------------------------------------------------------------------------
  _calcPullTarget(treb) {
    const sideSign    = this._role === "Player_1" ? 1 : -1;
    const aimStartX   = treb.x;
    const aimStartY   = treb.y + LOAD_TARGET_OFFSET_Y;
    const maxPull     = this._config.aimMaxPullDistance ?? BARRAGE_CONFIG.aimMaxPullDistance ?? MAX_PULL;
    const powerScale  = this._config.aimPowerScale ?? BARRAGE_CONFIG.aimPowerScale ?? 8;
    const maxVelocity = BARRAGE_CONFIG.trebuchetFireVelocityMax ?? V_MAX;

    const king = this._findEnemyKing();
    const ownKing = this._findOwnKing();
    const avoidOwnBlocks = this._shouldAvoidOwnBlocksThisShot();
    const ownBlocks = avoidOwnBlocks ? this._findOwnBlocks() : [];
    let angleDeg = 45;
    let pull = maxPull * this._pullScale;
    let targetError = null;
    let blockedByOwnBlock = null;
    if (king) {
      const shot = findBestShot(aimStartX, aimStartY, king, sideSign, maxPull, powerScale, maxVelocity, {
        avoidOwnBlocks,
        ownBlocks,
        ownKing,
      });
      angleDeg = shot.angleDeg;
      pull = shot.pull;
      targetError = shot.targetError;
      blockedByOwnBlock = shot.ownBlockHit;
    } else {
      console.warn("[AI] enemy king not found in state");
    }

    const halfJitter = (1 - this._effectiveAccuracy()) * MAX_JITTER_DEG;
    angleDeg += (Math.random() * 2 - 1) * halfJitter;
    angleDeg = Math.max(MIN_SHOT_ANGLE_DEG, Math.min(MAX_SHOT_ANGLE_DEG, angleDeg));
    const pullJitter = 1 + ((Math.random() * 2 - 1) * (1 - this._effectiveAccuracy()) * 0.12);
    pull = Math.max(maxPull * MIN_AIM_PULL_RATIO, Math.min(maxPull, pull * pullJitter));
    let effectiveV = Math.min(pull * powerScale, maxVelocity);

    // If the final trajectory passes through own king, keep raising angle until it clears.
    // This must happen after jitter; otherwise inaccuracy can undo the safety correction.
    if (ownKing) {
      const clearance = raiseAngleToClearKing(aimStartX, aimStartY, angleDeg, sideSign, effectiveV, ownKing);
      angleDeg = clearance.angle;
      if (clearance.attempts > 0) {
        console.log(`[AI] raised angle by ${clearance.attempts * KING_CLEAR_ANGLE_STEP}° to clear own king at (${ownKing.x.toFixed(1)},${ownKing.y.toFixed(1)})`);
      }
      if (!clearance.cleared) {
        console.warn(`[AI] could not fully clear own king at max angle ${MAX_SHOT_ANGLE_DEG}°`);
      }
    }

    // Most shots try to clear the AI's own defensive blocks, but some are
    // allowed to break them up like a human sometimes would.
    if (avoidOwnBlocks && ownBlocks.length > 0) {
      const clearance = raiseAngleToClearBlocks(aimStartX, aimStartY, angleDeg, sideSign, effectiveV, ownBlocks);
      angleDeg = clearance.angle;
      if (clearance.attempts > 0) {
        console.log(`[AI] raised angle by ${clearance.attempts * OWN_BLOCK_CLEAR_ANGLE_STEP}° to clear own blocks`);
      }
      if (!clearance.cleared && clearance.blockingBlock) {
        console.warn(`[AI] could not fully clear own block ${clearance.blockingBlock.id} at max angle ${MAX_SHOT_ANGLE_DEG}°`);
      }
    }

    effectiveV = Math.min(pull * powerScale, maxVelocity);
    console.log(`[AI] king=(${king?.x.toFixed(1)},${king?.y.toFixed(1)}) angle=${angleDeg.toFixed(1)}° pull=${pull.toFixed(2)}/${maxPull.toFixed(1)} v=${effectiveV.toFixed(1)} targetErr=${targetError?.toFixed(2) ?? "n/a"} avoidOwnBlocks=${avoidOwnBlocks}${blockedByOwnBlock ? ` blockedBy=${blockedByOwnBlock.id}` : ""}`);

    const rad = angleDeg * Math.PI / 180;
    return {
      x: aimStartX - sideSign * pull * Math.cos(rad),
      y: aimStartY - pull * Math.sin(rad),
    };
  }

  _adjustPullScale(landX) {
    const king = this._findEnemyKing();
    if (!king || !this._trebuchet) return;
    const trebX      = this._trebuchet.x;
    const shotDist   = Math.abs(landX  - trebX);
    const kingDist   = Math.abs(king.x - trebX);
    const error      = shotDist - kingDist; // positive = overshot, negative = undershot
    if (Math.abs(error) < ADJUST_DEAD_ZONE) return;
    // Scale adjustment by how far off the shot was, modulated by correctionAggression
    const aggression = this._config.correctionAggression ?? 0.5;
    const step       = Math.min(0.15, Math.abs(error) / kingDist * aggression);
    if (error > 0) {
      this._pullScale = Math.max(PULL_SCALE_MIN, this._pullScale - step);
    } else {
      this._pullScale = Math.min(1.0, this._pullScale + step);
    }
    console.log(`[AI] land x=${landX.toFixed(1)} king x=${king.x.toFixed(1)} err=${error.toFixed(1)} step=${step.toFixed(3)} → pullScale=${this._pullScale.toFixed(2)}`);
  }

  _findOwnKing() {
    if (!this._objects) return null;
    const pattern = this._role === "Player_1" ? "kingl" : "kingr";
    return this._objects.find((o) => o.id.toLowerCase().includes(pattern)) ?? null;
  }

  _shouldAvoidOwnBlocksThisShot() {
    const fraction = Number.isFinite(this._config.avoidOwnBlocks)
      ? this._config.avoidOwnBlocks
      : DEFAULT_AVOID_OWN_BLOCKS;
    return Math.random() < Math.max(0, Math.min(1, fraction));
  }

  _findOwnBlocks() {
    if (!this._objects) return [];
    const ownLeft = this._role === "Player_1";
    return this._objects.filter((o) => {
      if (!isBlockId(o.id)) return false;
      return ownLeft ? o.x < 0 : o.x > 0;
    });
  }

  _findEnemyKing() {
    if (!this._objects) return null;
    const pattern = this._role === "Player_1" ? "kingr" : "kingl";
    return this._objects.find((o) => o.id.toLowerCase().includes(pattern)) ?? null;
  }
}
