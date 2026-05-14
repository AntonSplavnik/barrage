import { captureImpactVelocities } from "./server-events.js";

export function runPhysicsSimulationTick({
  disposePhysicsAggregate,
  dt,
  fragmentBlock,
  gameObjects,
  handlePhysicsContacts,
  physicsContactEvents,
  processBombDetonations,
  simulatePhysics,
  tick,
  updateFragmentColliderShrinks,
  velocityFor,
}) {
  captureImpactVelocities(gameObjects.values(), {
    velocityFor,
  });

  if (physicsContactEvents) {
    physicsContactEvents.length = 0;
  }

  updateFragmentColliderShrinks?.(tick);
  simulatePhysics(dt);
  const havokContacts = physicsContactEvents ? [...physicsContactEvents] : [];
  handlePhysicsContacts?.(havokContacts);
  processBombDetonations?.(tick);

  return processPendingPhysicsObjects({
    fragmentBlock,
    gameObjects,
    disposePhysicsAggregate,
    tick,
    havokContacts,
  });
}

function processPendingPhysicsObjects({
  disposePhysicsAggregate,
  fragmentBlock,
  gameObjects,
  havokContacts,
  tick,
}) {
  const fragmentHits = [];
  const fragmentationErrors = [];
  const removedObjectIds = [];

  for (const object of [...gameObjects.values()]) {
    if (object.pendingFragment) {
      try {
        fragmentBlock(object, object.pendingFragment);
      } catch (err) {
        object.pendingFragment = null;
        fragmentationErrors.push({ object, error: err });
      }
    }

    if (object.pendingDispose !== undefined && tick >= object.pendingDispose) {
      removedObjectIds.push(object.id);
      disposePhysicsAggregate?.(object.id);
      gameObjects.delete(object.id);
      continue;
    }

    if (object.pendingRemove && object.isFragment) {
      if (object.removeOnTick === undefined) {
        object.removeOnTick = tick + 1;
        fragmentHits.push(object);
      } else if (tick >= object.removeOnTick) {
        disposePhysicsAggregate?.(object.id);
        gameObjects.delete(object.id);
      }
    } else if (object.isFragment && object.expiresOnTick !== undefined && tick >= object.expiresOnTick) {
      disposePhysicsAggregate?.(object.id);
      gameObjects.delete(object.id);
    }
  }

  return {
    fragmentationErrors,
    fragmentHits,
    havokContacts,
    removedObjectIds,
  };
}
