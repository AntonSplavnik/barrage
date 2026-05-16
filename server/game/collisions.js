import { scene, physicsAggregates } from "./physics.js";
import { gameObjects, gameState } from "./state.js";
import { isMissileName, isBlockName, isFragmentName } from "./entities.js";
import { getActiveLevel, getHookContext } from "./modeRunner.js";
import { broadcast } from "../net/broadcast.js";
import { getConfig, TICK_MS } from "../config.js";
import { shatterBlock, deleteBlock } from "./fragmentation.js";

const pendingBlockHits = new Map();

function objectIdFromBody(body) {
  const name = body.transformNode?.name;
  if (!name) return null;
  const prefix = "physics-";
  return name.startsWith(prefix) ? name.slice(prefix.length) : null;
}

function handleMissileBlockHit(missile, block) {
  if (!block.maxHits) return;
  if (missile.loadedInto) return;
  if (block.removing) return;

  const hitKey = `${missile.id}:${block.id}`;
  const lastTick = pendingBlockHits.get(hitKey);
  if (lastTick === gameState.tick) return;
  pendingBlockHits.set(hitKey, gameState.tick);

  block.hitStage = (block.hitStage ?? 0) + 1;

  if (getConfig("crackSystem") && block.hitStage < block.maxHits) {
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
    if (!objA || !objB) return;

    const missileA = isMissileName(idA);
    const missileB = isMissileName(idB);
    if (!missileA && !missileB) return;

    const missile = missileA ? objA : objB;
    const other = missileA ? objB : objA;
    const otherId = missileA ? idB : idA;

    if (isBlockName(otherId) && !isFragmentName(otherId)) {
      handleMissileBlockHit(missile, other);
    } else if (isFragmentName(otherId)) {
      handleMissileFragmentHit(missile, other);
    }
  });
}

export function clearCollisionState() {
  pendingBlockHits.clear();
}
