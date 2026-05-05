import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { clients, gameState } from "./state.js";
import { PORT, TICK_RATE, TICK_MS } from "./config.js";
import { enableHavokPhysics } from "./physics.js";
import { loadLevelIfPresent } from "./level.js";
import { simulatePhysics } from "./simulation.js";
import { sendState } from "./network.js";
import { applyInput } from "./input.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const publicDir = path.join(__dirname, "../public");

const app = express();
app.use((_request, response, next) => {
  response.setHeader("Cache-Control", "no-store");
  next();
});
app.use(express.static(publicDir));

const httpServer = http.createServer(app);
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
    level: `/assets/level1.glb`,
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

await new Promise((resolve) => {
  httpServer.listen(PORT, () => {
    console.log(`Barrage server running at http://localhost:${PORT}`);
    resolve();
  });
});

await enableHavokPhysics();
await loadLevelIfPresent();

setInterval(() => {
  gameState.tick += 1;
  simulatePhysics(TICK_MS / 1000);
  sendState();
}, TICK_MS);
