import { CLIENT_CONFIG } from "./clientConfig.js";

export const CONFIG = CLIENT_CONFIG;

const {
  Engine,
  WebGPUEngine,
  Scene,
} = BABYLON;

export const canvas = document.getElementById("game");
export const connectionEl = document.getElementById("connection");
export const playerEl = document.getElementById("player");
export const resetEl = document.getElementById("reset");
export const restartServerEl = document.getElementById("restart-server");
export const scoreLeftEl = document.getElementById("score-left");
export const scoreRightEl = document.getElementById("score-right");
export const matchEndEl = document.getElementById("match-end");
export const matchEndTextEl = document.getElementById("match-end-text");
export const rematchEl = document.getElementById("rematch");
export const sfxToggleEl = document.getElementById("sfx-toggle");

async function createEngine(canvas) {
  if (navigator.gpu && WebGPUEngine) {
    try {
      const eng = new WebGPUEngine(canvas, { antialias: true });
      await eng.initAsync();
      return eng;
    } catch {
      // WebGPU unavailable, fall back to WebGL
    }
  }
  return new Engine(canvas, true);
}

export const engine = await createEngine(canvas);
export const scene = new Scene(engine);
window.__scene = scene;
scene.imageProcessingConfiguration.exposure = CONFIG.exposure ?? 1.0;
scene.imageProcessingConfiguration.contrast = CONFIG.contrast ?? 1.0;
