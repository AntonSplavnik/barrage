import { Vector3, Quaternion } from "@babylonjs/core/Maths/math.vector.js";
import { physicsAggregates, createConvexHullBody } from "./physics.js";
import { gameObjects, gameState, destroyedBlocks } from "./state.js";
import { getTemplate } from "./templateRegistry.js";
import { broadcast } from "../net/broadcast.js";
import { BARRAGE_CONFIG } from "../../public/config.js";
import { SERVER_CONFIG } from "../config.js";

function randomSpread(max) {
  return (Math.random() - 0.5) * 2 * max;
}

export function shatterBlock(block, missile) {
  if (!block.fragmentTemplate) return;

  const template = getTemplate(block.fragmentTemplate);
  if (!template?.fragments || template.fragments.length === 0) {
    deleteBlock(block);
    return;
  }

  const fragIds = [];
  const blockRot = (block.rot ?? 0) * Math.PI / 180;
  const cosR = Math.cos(blockRot);
  const sinR = Math.sin(blockRot);

  const spreadX = BARRAGE_CONFIG.fragmentSpreadX ?? 4;
  const spreadY = BARRAGE_CONFIG.fragmentSpreadY ?? 2;
  const lifetimeMs = BARRAGE_CONFIG.fragmentLifetimeMs ?? 5000;

  const missileSpeed = Math.hypot(missile.vx ?? 0, missile.vy ?? 0, missile.vz ?? 0);
  const missileDir = missileSpeed > 0.01
    ? { x: missile.vx / missileSpeed, y: missile.vy / missileSpeed }
    : { x: 1, y: 0 };

  for (const frag of template.fragments) {
    const rotatedX = frag.localX * cosR - frag.localY * sinR;
    const rotatedY = frag.localX * sinR + frag.localY * cosR;

    const worldX = block.x + rotatedX;
    const worldY = block.y + rotatedY;
    const worldZ = block.z + (frag.localZ ?? 0);

    const fragId = `${block.id}_frag_${frag.pieceIndex}`;

    const fragObj = {
      id: fragId,
      x: worldX,
      y: worldY,
      z: worldZ,
      originX: worldX,
      originY: worldY,
      originZ: worldZ,
      rot: block.rot ?? 0,
      originRot: 0,
      angularVelocity: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      dragVx: 0,
      dragVy: 0,
      dragVz: 0,
      dynamic: true,
      draggedBy: null,
      offsetX: frag.offsetX,
      offsetY: frag.offsetY,
      offsetZ: frag.offsetZ,
      halfX: frag.halfX,
      halfY: frag.halfY,
      halfZ: frag.halfZ,
      halfHeight: frag.halfY,
      mass: SERVER_CONFIG.dynamicMass,
      friction: SERVER_CONFIG.dynamicFriction,
      restitution: SERVER_CONFIG.dynamicRestitution,
      player: null,
      isFragment: true,
      parentBlockId: block.id,
      createdTick: gameState.tick,
      pieceIndex: frag.pieceIndex,
      fragmentTemplate: block.fragmentTemplate,
      expiresAt: Date.now() + lifetimeMs,
      removing: false,
      removeAfterMs: null,
    };

    gameObjects.set(fragId, fragObj);

    if (frag.convexPositions) {
      const aggregate = createConvexHullBody(
        fragId,
        frag.convexPositions,
        new Vector3(worldX, worldY, worldZ),
        Quaternion.FromEulerAngles(0, 0, blockRot),
        {
          mass: SERVER_CONFIG.dynamicMass,
          friction: SERVER_CONFIG.dynamicFriction,
          restitution: SERVER_CONFIG.dynamicRestitution,
        },
      );
      aggregate.body.disablePreStep = true;
      aggregate.body.setLinearDamping(0.15);
      aggregate.body.setAngularDamping(0.55);
      aggregate.body.setCollisionCallbackEnabled(true);

      const impactVx = missileDir.x * missileSpeed * 0.3 + randomSpread(spreadX);
      const impactVy = missileDir.y * missileSpeed * 0.3 + Math.abs(randomSpread(spreadY));
      aggregate.body.setLinearVelocity(new Vector3(impactVx, impactVy, 0));
      aggregate.body.setAngularVelocity(new Vector3(0, 0, randomSpread(8)));

      physicsAggregates.set(fragId, aggregate);
    }

    fragIds.push({ id: fragId, pieceIndex: frag.pieceIndex });
  }

  broadcast({
    type: "event",
    tick: gameState.tick,
    events: [{
      kind: "blockBroken",
      blockId: block.id,
      fragIds,
    }],
  });

  deleteBlock(block);
}

function deleteBlock(block) {
  destroyedBlocks.set(block.id, { ...block });
  const aggregate = physicsAggregates.get(block.id);
  if (aggregate) {
    aggregate.dispose();
    physicsAggregates.delete(block.id);
  }
  gameObjects.delete(block.id);
}

export function processFragmentLifecycle() {
  const now = Date.now();
  const shrinkMs = BARRAGE_CONFIG.fragmentShrinkMs ?? 500;

  for (const object of gameObjects.values()) {
    if (!object.isFragment) continue;

    if (object.removing && object.removeAfterMs && now >= object.removeAfterMs) {
      const aggregate = physicsAggregates.get(object.id);
      if (aggregate) {
        aggregate.dispose();
        physicsAggregates.delete(object.id);
      }
      gameObjects.delete(object.id);
      continue;
    }

    if (!object.removing && now >= object.expiresAt) {
      object.removing = true;
      object.removeAfterMs = now + shrinkMs;

      const aggregate = physicsAggregates.get(object.id);
      if (aggregate?.shape) {
        aggregate.shape.isTrigger = true;
      }

      broadcast({
        type: "event",
        tick: gameState.tick,
        events: [{ kind: "fragmentRemoving", fragId: object.id }],
      });
    }
  }
}
