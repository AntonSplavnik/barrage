import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Scene } from "@babylonjs/core/scene.js";
import "@babylonjs/core/Physics/v2/physicsEngineComponent.js";

export const engine = new NullEngine({
  renderHeight: 1,
  renderWidth: 1,
  textureSize: 1,
  deterministicLockstep: false,
});

export const scene = new Scene(engine);
scene.activeCamera = new FreeCamera("HeadlessCamera", new Vector3(0, 10, -10), scene);

export const clients = new Map();
export const gameObjects = new Map();
export const dragState = new Map();
export const loadTargets = new Map();
export const physicsAggregates = new Map();

export const gameState = {
  tick: 0,
  nextClientId: 1,
  roundNumber: 1,
  scores: {},
  paused: false,
};
