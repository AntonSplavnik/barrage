import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { scene, physicsAggregates } from "./physics.js";
import { gameObjects, gameState } from "./state.js";
import { isMissileName, isBlockName, isFragmentName, isTrebuchetName, isKingName, isGroundName } from "./entities.js";
import { broadcastSfx } from "./sound.js";
import { getActiveLevel, getHookContext } from "./modeRunner.js";
import { broadcast } from "../net/broadcast.js";
import { getConfig, TICK_MS } from "../config.js";
import { shatterBlock, deleteBlock } from "./fragmentation.js";
import { triggerExplosion, removeBomb } from "./explosion.js";

const pendingBlockHits = new Map();

function objectIdFromBody(body) {
  const name = body.transformNode?.name;
  if (!name) return null;
  const prefix = "physics-";
  return name.startsWith(prefix) ? name.slice(prefix.length) : null;
}

const SFX_MIN_SPEED = 1.2;
const sfxPairTicks = new Map();

function broadcastPairSfx(idA, idB, effect, opts) {
  const key = idA < idB ? `${idA}:${idB}` : `${idB}:${idA}`;
  if (sfxPairTicks.get(key) === gameState.tick) return;
  sfxPairTicks.set(key, gameState.tick);
  broadcastSfx(effect, opts);
}

function impactSpeed(a, b) {
  return Math.hypot(
    (a.vx ?? 0) - (b.vx ?? 0),
    (a.vy ?? 0) - (b.vy ?? 0),
    (a.vz ?? 0) - (b.vz ?? 0),
  );
}

function midpointX(a, b) {
  return (a.x + b.x) / 2;
}

function handleMissileBlockHit(missile, block) {
  if (missile.loadedInto) return;
  if (block.removing) return;

  const speed = Math.hypot(missile.vx ?? 0, missile.vy ?? 0, missile.vz ?? 0);
  const x = midpointX(missile, block);

  if (speed < getConfig("missileDamageMinSpeed")) return;

  const force = getConfig("missileHitForce");
  if (force > 0 && speed > 0) {
    const aggregate = physicsAggregates.get(block.id);
    if (aggregate) {
      const scale = force / speed;
      aggregate.body.applyImpulse(
        new Vector3((missile.vx ?? 0) * scale, (missile.vy ?? 0) * scale, 0),
        aggregate.transformNode.getAbsolutePosition(),
      );
    }
  }

  if (!block.maxHits) {
    broadcastSfx("missile_hit_block", { speed, x });
    return;
  }

  const hitKey = `${missile.id}:${block.id}`;
  const lastTick = pendingBlockHits.get(hitKey);
  if (lastTick === gameState.tick) return;
  pendingBlockHits.set(hitKey, gameState.tick);

  block.hitStage = (block.hitStage ?? 0) + 1;

  if (getConfig("crackSystem") && block.hitStage < block.maxHits) {
    broadcastSfx("missile_crack_block", { speed, x });
    broadcast({
      type: "event",
      tick: gameState.tick,
      events: [{ kind: "blockHit", blockId: block.id, hitStage: block.hitStage }],
    });
  } else {
    const hook = getActiveLevel()?.def.hooks?.onBlockDestroyed;
    if (hook) {
      hook(block, missile, getHookContext());
    } else if (getConfig("fragmentation")) {
      shatterBlock(block, missile);
    } else {
      broadcastSfx("missile_hit_block", { speed, x });
      deleteBlock(block);
    }
  }
}

function handleMissileFragmentHit(missile, fragment) {
  if (fragment.removing) return;
  if (missile.loadedInto) return;

  const immunityMs = getConfig("fragmentImmunityMs");
  const elapsedTicks = gameState.tick - fragment.createdTick;
  if (elapsedTicks * TICK_MS < immunityMs) return;

  fragment.removing = true;
  fragment.removeAfterMs = Date.now() + getConfig("fragmentShrinkMs");

  const aggregate = physicsAggregates.get(fragment.id);
  if (aggregate?.shape) {
    aggregate.shape.isTrigger = true;
  }

  const penalty = getConfig("fragmentHitSpeedPenalty");
  const speed = Math.hypot(missile.vx, missile.vy, missile.vz);
  if (speed > penalty) {
    const scale = (speed - penalty) / speed;
    missile.vx *= scale;
    missile.vy *= scale;
    missile.vz *= scale;
  }

  broadcast({
    type: "event",
    tick: gameState.tick,
    events: [{ kind: "fragmentRemoving", fragId: fragment.id }],
  });
}

export function initCollisions() {
  const plugin = scene.getPhysicsEngine()?.getPhysicsPlugin();
  if (!plugin?.onCollisionObservable) {
    console.warn("No collision observable available — collisions disabled.");
    return;
  }

  plugin.onCollisionObservable.add((event) => {
    if (event.type !== "COLLISION_STARTED") return;

    const idA = objectIdFromBody(event.collider);
    const idB = objectIdFromBody(event.collidedAgainst);
    if (!idA || !idB) return;

    const objA = gameObjects.get(idA);
    const objB = gameObjects.get(idB);

    const missileA = isMissileName(idA);
    const missileB = isMissileName(idB);

    // --- Missile collisions ---
    if (missileA || missileB) {
      const missile = missileA ? objA : objB;
      const other = missileA ? objB : objA;
      const otherId = missileA ? idB : idA;

      if (!missile) return;

      const missileSpeed = Math.hypot(missile.vx ?? 0, missile.vy ?? 0, missile.vz ?? 0);

      if (missile.missileType === "bomb" && !missile.loadedInto && missileSpeed >= getConfig("bombDetonationMinSpeed")) {
        const bombPos = { x: missile.x, y: missile.y, z: missile.z };
        removeBomb(missile);
        triggerExplosion(missile.id, bombPos, {
          radius: getConfig("bombBlastRadius"),
          maxDamage: getConfig("bombMaxDamage"),
          maxForce: getConfig("bombMaxForce"),
        });
        if (other && isMissileName(otherId) && other.missileType === "bomb" && gameObjects.has(otherId)) {
          const otherPos = { x: other.x, y: other.y, z: other.z };
          removeBomb(other);
          triggerExplosion(other.id, otherPos, {
            radius: getConfig("bombBlastRadius"),
            maxDamage: getConfig("bombMaxDamage"),
            maxForce: getConfig("bombMaxForce"),
          });
        }
        return;
      }

      if (missile.missileType === "bomb") return;

      if (other && isMissileName(otherId) && other.missileType === "bomb" && !other.loadedInto) {
        const otherSpeed = Math.hypot(other.vx ?? 0, other.vy ?? 0, other.vz ?? 0);
        if (otherSpeed >= getConfig("bombDetonationMinSpeed")) {
          const otherPos = { x: other.x, y: other.y, z: other.z };
          removeBomb(other);
          triggerExplosion(other.id, otherPos, {
            radius: getConfig("bombBlastRadius"),
            maxDamage: getConfig("bombMaxDamage"),
            maxForce: getConfig("bombMaxForce"),
          });
        }
        return;
      }

      if (isBlockName(otherId) && !isFragmentName(otherId) && other) {
        handleMissileBlockHit(missile, other);
        return;
      }
      if (isFragmentName(otherId) && other) {
        broadcastPairSfx(idA, idB, "missile_hits_fragment", { speed: missileSpeed, x: missile.x });
        handleMissileFragmentHit(missile, other);
        return;
      }
      if (missileA && missileB) {
        if (objA && objB) {
          broadcastPairSfx(idA, idB, "missile_hit_missile", { speed: impactSpeed(objA, objB), x: midpointX(objA, objB) });
        }
        return;
      }
      if (isGroundName(otherId)) {
        broadcastPairSfx(idA, idB, "missile_hit_ground", { speed: missileSpeed, x: missile.x });
        return;
      }
      if (isTrebuchetName(otherId)) {
        if (missile.loadedInto) return;
        broadcastPairSfx(idA, idB, "missile_hit_trebuchet", { speed: missileSpeed, x: missile.x });
        return;
      }
      if (isKingName(otherId)) {
        broadcastPairSfx(idA, idB, "king_hit", { speed: missileSpeed, x: missile.x });
        return;
      }
      return;
    }

    // --- Non-missile collisions ---
    const blockA = isBlockName(idA) && !isFragmentName(idA);
    const blockB = isBlockName(idB) && !isFragmentName(idB);
    const groundA = isGroundName(idA);
    const groundB = isGroundName(idB);

    if (blockA && groundB && objA) {
      const speed = Math.hypot(objA.vx ?? 0, objA.vy ?? 0, objA.vz ?? 0);
      if (speed < SFX_MIN_SPEED) return;
      broadcastPairSfx(idA, idB, "block_hit_ground", { speed, x: objA.x });
      return;
    }
    if (blockB && groundA && objB) {
      const speed = Math.hypot(objB.vx ?? 0, objB.vy ?? 0, objB.vz ?? 0);
      if (speed < SFX_MIN_SPEED) return;
      broadcastPairSfx(idA, idB, "block_hit_ground", { speed, x: objB.x });
      return;
    }
    if (blockA && blockB && objA && objB) {
      const speed = impactSpeed(objA, objB);
      if (speed < SFX_MIN_SPEED) return;
      broadcastPairSfx(idA, idB, "block_hit_block", { speed, x: midpointX(objA, objB) });
      return;
    }
  });
}

export function clearCollisionState() {
  pendingBlockHits.clear();
  sfxPairTicks.clear();
}
