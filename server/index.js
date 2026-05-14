import express from "express";
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PORT } from "./config.js";
import { clients } from "./game/state.js";
import { enableHavokPhysics } from "./game/physics.js";
import { startMode } from "./game/modeRunner.js";
import classicMode from "./game/modes/classic.js";
import { initTemplateRegistry } from "./game/templateRegistry.js";
import { setupWebSocket } from "./net/connections.js";
import { startGameLoop, stopGameLoop } from "./game/loop.js";
import { initCollisions } from "./game/collisions.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const publicDir = path.join(__dirname, "../public");

const app = express();
app.use((_request, response, next) => {
  response.setHeader("Cache-Control", "no-store");
  next();
});

const httpServer = http.createServer(app);
const wss = setupWebSocket(httpServer);

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

  stopGameLoop();

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

await new Promise((resolve) => {
  httpServer.listen(PORT, () => {
    console.log(`Barrage server running at http://localhost:${PORT}`);
    resolve();
  });
});

await enableHavokPhysics();
await initTemplateRegistry();
await startMode(classicMode);
initCollisions();

startGameLoop();
