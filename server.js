import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BARRAGE_CONFIG } from "./public/config.js";
import authRouter from "./src/server/auth.js";
import lobbyRouter from "./src/server/lobby.js";
import signalingRouter from "./src/server/signaling.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const publicDir = path.join(__dirname, "public");

const ASSET_PREFIXES = ["/assets/", "/backgrounds/", "/sounds/"];

const app = express();

app.use((_req, res, next) => {
  const isAsset = ASSET_PREFIXES.some(p => _req.path.startsWith(p));
  res.setHeader("Cache-Control", isAsset && BARRAGE_CONFIG.cacheAssets ? "public, max-age=3600" : "no-store");
  next();
});

app.use(express.json());
app.use("/api", authRouter);
app.use("/api", lobbyRouter);
app.use("/api", signalingRouter);

// JSON error handler for all /api routes
app.use("/api", (err, _req, res, _next) => {
  console.error("[api error]", err.message);
  res.status(500).json({ ok: false, error: "server-error" });
});

app.use(express.static(publicDir));

const httpServer = http.createServer(app);

httpServer.listen(PORT, () => {
  console.log(`Barrage server running on port ${PORT}`);
});
