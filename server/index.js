import express from "express";
import http from "node:http";
import { spawn } from "node:child_process";
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

const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer });

let simulationInterval = null;
let restartInProgress = false;

function isLocalRequest(request) {
  const remoteAddress = request.ip || request.socket.remoteAddress || "";
  return remoteAddress === "::1"
    || remoteAddress === "127.0.0.1"
    || remoteAddress === "::ffff:127.0.0.1";
}

function closeSocket(socket) {
  try {
    socket.terminate();
  } catch {
    // Ignore restart close races.
  }
}

function closeWithTimeout(closeFn, timeoutMs = 1000) {
  return new Promise((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const timer = setTimeout(finish, timeoutMs);
    closeFn(() => {
      clearTimeout(timer);
      finish();
    });
  });
}

async function restartServerProcess() {
  if (restartInProgress) return;
  restartInProgress = true;
  console.log("Restart requested from local browser.");

  if (simulationInterval) {
    clearInterval(simulationInterval);
    simulationInterval = null;
  }

  for (const client of clients.values()) {
    closeSocket(client.socket);
  }

  await closeWithTimeout((done) => wss.close(done));
  await closeWithTimeout((done) => httpServer.close(done));

  const child = spawn(process.execPath, [path.join(__dirname, "index.js")], {
    cwd: __dirname,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  process.exit(0);
}

app.post("/admin/restart", (request, response) => {
  if (!isLocalRequest(request)) {
    response.status(403).json({ ok: false, error: "local-only" });
    return;
  }

  if (restartInProgress) {
    response.status(409).json({ ok: false, error: "restart-in-progress" });
    return;
  }

  response.json({ ok: true, restarting: true });
  response.on("finish", () => {
    restartServerProcess().catch((error) => {
      console.error("Failed to restart server process.", error);
      process.exit(1);
    });
  });
});

app.use(express.static(publicDir));

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

simulationInterval = setInterval(() => {
  gameState.tick += 1;
  simulatePhysics(TICK_MS / 1000);
  sendState();
}, TICK_MS);
