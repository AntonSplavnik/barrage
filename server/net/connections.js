import { WebSocketServer } from "ws";
import { clients, gameState } from "../game/state.js";
import { TICK_RATE } from "../config.js";
import { applyInput } from "../game/input.js";

export function setupWebSocket(httpServer) {
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (socket) => {
    const clientId = gameState.nextClientId++;
    const playerId = clientId === 1 ? "P1" : clientId === 2 ? "P2" : `Spectator_${clientId}`;
    const client = { id: clientId, playerId, socket };
    clients.set(clientId, client);

    socket.send(JSON.stringify({
      type: "welcome",
      clientId,
      playerId,
      tickRate: TICK_RATE,
      level: gameState.currentLevel?.url ?? `/assets/level1.glb`,
    }));

    socket.on("message", (raw) => {
      try {
        applyInput(client, JSON.parse(raw.toString()));
      } catch (error) {
        socket.send(JSON.stringify({ type: "error", message: "Invalid message JSON" }));
      }
    });

    socket.on("close", () => {
      clients.delete(clientId);
    });
  });

  return wss;
}
