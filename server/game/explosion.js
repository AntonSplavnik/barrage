import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { physicsAggregates } from "./physics.js";
import { gameObjects, gameState, dragState } from "./state.js";
import { isMissileName } from "./entities.js";
import { getConfig } from "../config.js";
import { getActiveLevel, getHookContext } from "./modeRunner.js";
import { shatterBlock, deleteBlock } from "./fragmentation.js";
import { broadcast } from "../net/broadcast.js";
import { broadcastSfx } from "./sound.js";

export function removeBomb(bomb) {
  const aggregate = physicsAggregates.get(bomb.id);
  if (aggregate) {
    aggregate.dispose();
    physicsAggregates.delete(bomb.id);
  }
  gameObjects.delete(bomb.id);
  dragState.delete(bomb.id);
}

export function triggerExplosion(bombId, position, config) {
  const { radius, maxDamage, maxForce } = config;
  const pendingDetonations = [];

  for (const object of gameObjects.values()) {
    const dx = object.x - position.x;
    const dy = object.y - position.y;
    const dz = object.z - position.z;
    const distance = Math.hypot(dx, dy, dz);

    if (distance > radius) continue;
    if (object.loadedInto || object.draggedBy || object.removing) continue;

    const strength = 1 - (distance / radius);

    if (object.hitStage !== undefined && object.fragmentTemplate) {
      applyExplosionDamage(object, strength, maxDamage);
    }

    applyExplosionForce(object, position, strength, maxForce);

    if (isMissileName(object.id) && object.missileType === "bomb") {
      pendingDetonations.push(object);
    }
  }

  broadcastSfx("missile_bomb_explosion", { speed: maxForce, x: position.x });

  broadcast({
    type: "event",
    tick: gameState.tick,
    events: [{
      kind: "explosion",
      bombId,
      x: position.x,
      y: position.y,
      z: position.z,
      radius,
    }],
  });

  for (const bomb of pendingDetonations) {
    if (!gameObjects.has(bomb.id)) continue;
    const pos = { x: bomb.x, y: bomb.y, z: bomb.z };
    removeBomb(bomb);
    triggerExplosion(bomb.id, pos, {
      radius: getConfig("bombBlastRadius"),
      maxDamage: getConfig("bombMaxDamage"),
      maxForce: getConfig("bombMaxForce"),
    });
  }
}

function applyExplosionDamage(block, strength, maxDamage) {
  const damage = Math.ceil(maxDamage * strength);
  block.hitStage = (block.hitStage ?? 0) + damage;

  if (getConfig("crackSystem") && block.hitStage < block.maxHits) {
    broadcastSfx("missile_crack_block", { speed: 10, x: block.x });
    broadcast({
      type: "event",
      tick: gameState.tick,
      events: [{ kind: "blockHit", blockId: block.id, hitStage: block.hitStage }],
    });
  } else {
    const hook = getActiveLevel()?.def.hooks?.onBlockDestroyed;
    if (hook) {
      hook(block, null, getHookContext());
    } else if (getConfig("fragmentation")) {
      const syntheticSpeed = getConfig("bombMaxForce") * strength;
      shatterBlock(block, { vx: syntheticSpeed, vy: 0, vz: 0 });
    } else {
      deleteBlock(block);
    }
  }
}

function applyExplosionForce(object, position, strength, maxForce) {
  const aggregate = physicsAggregates.get(object.id);
  if (!aggregate) return;

  const dx = object.x - position.x;
  const dy = object.y - position.y;
  const dist2D = Math.hypot(dx, dy);
  const magnitude = maxForce * strength;

  let impulseX, impulseY;
  if (dist2D < 0.001) {
    impulseX = 0;
    impulseY = magnitude;
  } else {
    impulseX = (dx / dist2D) * magnitude;
    impulseY = (dy / dist2D) * magnitude;
  }

  aggregate.body.applyImpulse(
    new Vector3(impulseX, impulseY, 0),
    aggregate.transformNode.getAbsolutePosition(),
  );
}
