import { runPhysicsSimulationTick } from "./physics-sim.js";

export function createSimulationRunner({
  bindRoom,
  broadcast,
  broadcastImpactSoundEffect,
  checkKingKnockout,
  disposePhysicsAggregate,
  fragmentBlock,
  getActiveRoom,
  getGameObjects,
  getPhysicsContactEvents,
  getTick,
  handlePhysicsContacts,
  impactSpeedFor,
  incrementTick,
  physicsVelocityForObject,
  playerIdForKing,
  processBombDetonations,
  recordRoundWin,
  saveActiveRoomTick,
  sendState,
  simulatePhysics,
  tickMs,
  updateFragmentColliderShrinks,
}) {
  function handlePhysicsSimulationResults(results) {
    for (const { object, error } of results.fragmentationErrors) {
      console.error(`fragmentBlock failed for ${object.id}:`, error);
    }

    for (const object of results.fragmentHits) {
      broadcastImpactSoundEffect("missile_hits_fragment", {
        x: object.hitImpactX ?? object.x,
        y: object.hitImpactY ?? object.y,
        z: object.hitImpactZ ?? object.z,
      }, object.hitImpactSpeed ?? impactSpeedFor(object));
      broadcast({
        type: "event",
        roomId: getActiveRoom().id,
        tick: getTick(),
        events: [{ kind: "fragmentHit", fragId: object.id }],
      });
    }

    for (const objectId of results.removedObjectIds ?? []) {
      broadcast({
        type: "event",
        roomId: getActiveRoom().id,
        tick: getTick(),
        events: [{ kind: "objectRemoved", objectId }],
      });
    }
  }

  function runRoomSimulationTick(room) {
    bindRoom(room);
    const tick = incrementTick();
    const gameObjects = getGameObjects();
    const physicsResults = runPhysicsSimulationTick({
      disposePhysicsAggregate,
      dt: tickMs / 1000,
      fragmentBlock,
      gameObjects,
      handlePhysicsContacts,
      physicsContactEvents: getPhysicsContactEvents(),
      processBombDetonations,
      simulatePhysics,
      tick,
      updateFragmentColliderShrinks,
      velocityFor: physicsVelocityForObject,
    });
    handlePhysicsSimulationResults(physicsResults);

    const knockedKing = checkKingKnockout(gameObjects);
    if (knockedKing) recordRoundWin(playerIdForKing(knockedKing));

    sendState();
    saveActiveRoomTick();
  }

  return {
    handlePhysicsSimulationResults,
    runRoomSimulationTick,
  };
}
