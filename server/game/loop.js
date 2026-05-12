import { gameState } from "./state.js";
import { TICK_MS } from "../config.js";
import { simulatePhysics } from "./simulation.js";
import { tryRecordRoundWin } from "./rules.js";
import { sendState } from "../net/broadcast.js";

let simulationInterval = null;

export function startGameLoop() {
  simulationInterval = setInterval(() => {
    if (gameState.paused) return;
    gameState.tick += 1;
    simulatePhysics();
    tryRecordRoundWin();
    sendState();
  }, TICK_MS);
}

export function stopGameLoop() {
  if (simulationInterval) {
    clearInterval(simulationInterval);
    simulationInterval = null;
  }
}
