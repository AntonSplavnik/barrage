import { CLIENT_CONFIG } from "./clientConfig.js";

export const CONFIG = CLIENT_CONFIG;

const {
  Engine,
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

export const engine = new Engine(canvas, true);
export const scene = new Scene(engine);
scene.clearColor.set(0.62, 0.72, 0.78, 1);
scene.imageProcessingConfiguration.exposure = CONFIG.exposure ?? 1.0;
scene.imageProcessingConfiguration.contrast = CONFIG.contrast ?? 1.0;
