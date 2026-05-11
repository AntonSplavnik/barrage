import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera.js";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Scene } from "@babylonjs/core/scene.js";

export function createRoomRuntime(room) {
  room.engine?.dispose?.();
  room.scene?.dispose?.();

  const roomEngine = new NullEngine({
    renderHeight: 1,
    renderWidth: 1,
    textureSize: 1,
    deterministicLockstep: false,
  });
  const roomScene = new Scene(roomEngine);
  roomScene.activeCamera = new FreeCamera(`HeadlessCamera-${room.id}`, new Vector3(0, 10, -10), roomScene);

  room.engine = roomEngine;
  room.scene = roomScene;
  room.tick = 0;
  room.gameObjects = new Map();
  room.dragState = new Map();
  room.loadTargets = new Map();
  room.physicsAggregates = new Map();
  room.physicsCollisionObservers = new Map();
  room.physicsContactEvents = [];
  room.impactSoundTicks = new Map();
}

export function createRoomState({ roomInfo, firstLevel }) {
  const { id, index, playerIds } = roomInfo;
  const room = {
    id,
    index,
    playerIds,
    clients: new Map(),
    level: firstLevel(),
    roundNumber: 1,
    scores: Object.fromEntries(playerIds.map((playerId) => [playerId, 0])),
    roundWinner: null,
    paused: false,
  };
  createRoomRuntime(room);
  return room;
}

export function resetRoomProgress(room, { firstLevel }) {
  room.level = firstLevel();
  room.roundNumber = 1;
  room.roundWinner = null;
  room.paused = false;
  room.scores = Object.fromEntries(room.playerIds.map((playerId) => [playerId, 0]));
}
