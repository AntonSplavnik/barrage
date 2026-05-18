import { clients, gameObjects, gameState } from "../game/state.js";
import { toWireObject } from "../game/entities.js";

export function broadcast(message) {
  const payload = JSON.stringify(message);
  for (const client of clients.values()) {
    if (client.socket.readyState === client.socket.OPEN) {
      client.socket.send(payload);
    }
  }
}

export function sendState() {
  const base = {
    type: "state",
    tick: gameState.tick,
    serverTime: Date.now(),
    roundNumber: gameState.roundNumber,
    scores: gameState.scores,
  };

  for (const client of clients.values()) {
    if (client.socket.readyState !== client.socket.OPEN) continue;
    const objects = [...gameObjects.values()].map(o => toWireObject(o, client.id));
    client.socket.send(JSON.stringify({ ...base, objects }));
  }
}
