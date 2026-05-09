import { clients, gameObjects, gameState } from "./state.js";
import { toWireObject } from "./utils.js";

export function broadcast(message) {
  const payload = JSON.stringify(message);
  for (const client of clients.values()) {
    if (client.socket.readyState === client.socket.OPEN) {
      client.socket.send(payload);
    }
  }
}

export function sendState() {
  broadcast({
    type: "state",
    tick: gameState.tick,
    serverTime: Date.now(),
    roundNumber: gameState.roundNumber,
    scores: gameState.scores,
    objects: [...gameObjects.values()].map(toWireObject),
  });
}
