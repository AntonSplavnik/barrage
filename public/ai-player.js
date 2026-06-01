// AiPlayer — local AI opponent running in the host browser.
// Posts the same input messages the human client sends, driven by a state machine.

import {
  isKingExposed, findFreeBlock,
  LIFT_CLEARANCE, PLACE_OFFSET, LOWER_SPEED_MS, SETTLE_SPEED, DEFENSE_TIMEOUT,
} from "./ai-defense.js";

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
const PULL_SCALE_MIN        = 0.5;   // minimum pull (limits minimum power)
const ADJUST_DEAD_ZONE      = 3;     // units — ignore errors smaller than this
const DRAG_ZENITH_Y         = 7;    // world-space y of arc apex when picking up a missile
const KING_CLEAR_RADIUS     = 4;     // m — trajectory must stay this far from own king
const KING_CLEAR_ANGLE_STEP = 5;     // degrees to add each retry when own king is in the way
const INITIAL_DELAY_MS      = 2000;

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
function dampedPos(x0, y0, vx, vy, t) {
  if (Math.abs(DAMPING) < 0.0001) {
    return {
      x: x0 + vx * t,
      y: y0 + vy * t + 0.5 * GRAVITY * t * t,
    };
  }
  const decay  = Math.exp(-DAMPING * t);
  const vScale = (1 - decay) / DAMPING;
  const gScale = t / DAMPING - (1 - decay) / (DAMPING * DAMPING);
  return {
    x: x0 + vx * vScale,
    y: y0 + vy * vScale + GRAVITY * gScale,
  };
}

function findBestAngle(fromX, fromY, targetX, targetY, sideSign, speed = V_MAX) {
  let bestAngle = 45;
  let bestError = Infinity;
  const step = 0.05; // simulation time step (s)

  for (let deg = 10; deg <= 75; deg += 1) {
    const rad = deg * Math.PI / 180;
    const vx  = speed * Math.cos(rad) * sideSign;
    const vy  = speed * Math.sin(rad);

    for (let t = step; t < 25; t += step) {
      const cur  = dampedPos(fromX, fromY, vx, vy, t);
      const prev = dampedPos(fromX, fromY, vx, vy, t - step);

      const passedTarget = sideSign > 0
        ? (prev.x < targetX && cur.x >= targetX)
        : (prev.x > targetX && cur.x <= targetX);

      if (passedTarget) {
        // Interpolate y at exact targetX crossing
        const alpha = Math.abs(targetX - prev.x) / Math.max(0.0001, Math.abs(cur.x - prev.x));
        const yAtTarget = prev.y + alpha * (cur.y - prev.y);
        const error = Math.abs(yAtTarget - targetY);
        if (error < bestError) {
          bestError = error;
          bestAngle = deg;
        }
        break;
      }

      if (cur.y < -10) break; // missile hit the ground
    }
  }

  return bestAngle;
}

// Returns true if the trajectory from (fromX,fromY) at (vx,vy) passes within
// KING_CLEAR_RADIUS of (kingX, kingY) at any point before hitting the ground.
function trajectoryHitsKing(fromX, fromY, vx, vy, kingX, kingY) {
  const step = 0.05;
  for (let t = step; t < 25; t += step) {
    const p = dampedPos(fromX, fromY, vx, vy, t);
    if (Math.hypot(p.x - kingX, p.y - kingY) < KING_CLEAR_RADIUS) return true;
    if (p.y < -10) break;
  }
  return false;
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
    this._pauseRemaining  = 0;
    this._waitLoadedMs       = 0;
    this._useOutside         = false;
    this._pullScale          = 1.0;
    this._firedMissileId     = null;
    this._lastKnownMissileX  = null;
    this._dragStart          = null;
    this._dragT              = 0;
    // Defense
    this._shotCount          = 0;
    this._doDefenseCheck     = false;
    this._defenseBlockId     = null;
    this._defenseMs          = 0;
    this._liftTargetY        = 0;
    this._carryTargetX       = 0;
    this._defenseCmdY        = 0;
  }

  onState(objects) {
    this._objects = objects;
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
  }

  reset() {
    this._pauseRemaining    = INITIAL_DELAY_MS;
    this._state             = STATE.PAUSE;
    this._targetMissile     = null;
    this._loadedMissile     = null;
    this._dragCurrent       = null;
    this._aimCurrent        = null;
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

    const { speed } = this._config;

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
        if (!missile) return;
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
        this._post({ type: "input", action: "aimStart",
          entityId: loaded.id,
          point:    { x: ax, y: ay, z: treb.z },
        });
        this._state = STATE.AIM_PULL;
        break;
      }

      case STATE.AIM_PULL: {
        if (!this._trebuchet || !this._loadedMissile) { this._state = STATE.FIND_MISSILE; return; }
        const treb = this._trebuchet;
        const pull = this._calcPullTarget(treb);
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
        this._liftTargetY    = ownKing.y + LIFT_CLEARANCE;
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

  // ---------------------------------------------------------------------------
  // Pull target: uses damped ballistic solver + adaptive angle correction + jitter.
  // ---------------------------------------------------------------------------
  _calcPullTarget(treb) {
    const sideSign    = this._role === "Player_1" ? 1 : -1;
    const aimStartX   = treb.x;
    const aimStartY   = treb.y + LOAD_TARGET_OFFSET_Y;
    const pull        = MAX_PULL * this._pullScale;
    const effectiveV  = Math.min(pull * 8, V_MAX);

    const king = this._findEnemyKing();
    let angleDeg = 45;
    if (king) {
      angleDeg = findBestAngle(aimStartX, aimStartY, king.x, king.y, sideSign, effectiveV);
    } else {
      console.warn("[AI] enemy king not found in state");
    }

    // If trajectory passes through own king, keep raising angle until it clears
    const ownKing = this._findOwnKing();
    if (ownKing) {
      let attempts = 0;
      while (attempts < 12) {
        const rad = angleDeg * Math.PI / 180;
        const vx  = effectiveV * Math.cos(rad) * sideSign;
        const vy  = effectiveV * Math.sin(rad);
        if (!trajectoryHitsKing(aimStartX, aimStartY, vx, vy, ownKing.x, ownKing.y)) break;
        angleDeg += KING_CLEAR_ANGLE_STEP;
        attempts++;
      }
      if (attempts > 0) {
        console.log(`[AI] raised angle by ${attempts * KING_CLEAR_ANGLE_STEP}° to clear own king at (${ownKing.x.toFixed(1)},${ownKing.y.toFixed(1)})`);
      }
    }

    console.log(`[AI] king=(${king?.x.toFixed(1)},${king?.y.toFixed(1)}) angle=${angleDeg}° pullScale=${this._pullScale.toFixed(2)} v=${effectiveV.toFixed(1)}`);

    const halfJitter = (1 - this._config.accuracy) * MAX_JITTER_DEG;
    angleDeg += (Math.random() * 2 - 1) * halfJitter;
    angleDeg = Math.max(10, Math.min(75, angleDeg));

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

  _findEnemyKing() {
    if (!this._objects) return null;
    const pattern = this._role === "Player_1" ? "kingr" : "kingl";
    return this._objects.find((o) => o.id.toLowerCase().includes(pattern)) ?? null;
  }
}
