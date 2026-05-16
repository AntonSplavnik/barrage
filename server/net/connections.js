import { WebSocketServer } from "ws";
import { clients, gameState } from "../game/state.js";
import { TICK_RATE, getClientRelevantConfig } from "../config.js";
import { applyInput } from "../game/input.js";
import { getAllPaths } from "../game/templateRegistry.js";
import { releaseDragForClient } from "../game/drag.js";

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
      level: gameState.currentLevel?.url ?? "/assets/levels/level1.glb",
      templates: getAllPaths(),
      config: getClientRelevantConfig(),
    }));

    socket.on("message", (raw) => {
      try {
        applyInput(client, JSON.parse(raw.toString()));
      } catch (error) {
        socket.send(JSON.stringify({ type: "error", message: "Invalid message JSON" }));
      }
    });

    socket.on("close", () => {
      releaseDragForClient(clientId);
      clients.delete(clientId);
    });
  });

  return wss;
}
