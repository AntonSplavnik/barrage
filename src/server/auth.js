import { Router } from "express";
import crypto from "node:crypto";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import db from "./db.js";

const SALT_ROUNDS = 10;
const JWT_SECRET = process.env.JWT_SECRET ?? "change-me-in-production";
const TOKEN_TTL = "7d";

export function createAuthToken(userId, username) {
  return jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function validateUsername(username) {
  if (!username || username.length < 2 || username.length > 24) return "username-length";
  if (!/^[a-zA-Z0-9_\-]+$/.test(username)) return "username-invalid-chars";
  return null;
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    res.status(401).json({ ok: false, error: "auth-required" });
    return;
  }
  try {
    req.auth = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ ok: false, error: "invalid-token" });
  }
}

const router = Router();
router.use((req, res, next) => {
  res.setHeader("Content-Type", "application/json");
  next();
});

// Quick play — name only, no password, no persistent account
router.post("/quickplay", async (req, res) => {
  const { name } = req.body ?? {};
  const err = validateUsername(name);
  if (err) { res.status(400).json({ ok: false, error: err }); return; }

  const suffix = crypto.randomBytes(3).toString("hex");
  const storedUsername = `${name}~${suffix}`;
  const now = Date.now();

  const result = await db.execute({
    sql: "INSERT INTO users (username, display_name, is_guest, password_hash, created_at) VALUES (?, ?, 1, '', ?)",
    args: [storedUsername, name, now],
  });

  const token = createAuthToken(Number(result.lastInsertRowid), name);
  res.status(201).json({ ok: true, token, username: name });
});

router.post("/register", async (req, res) => {
  const { username, password } = req.body ?? {};
  if (!username || !password) {
    res.status(400).json({ ok: false, error: "username-and-password-required" });
    return;
  }
  const usernameErr = validateUsername(username);
  if (usernameErr) { res.status(400).json({ ok: false, error: usernameErr }); return; }
  if (password.length < 6) {
    res.status(400).json({ ok: false, error: "password-too-short" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  try {
    const result = await db.execute({
      sql: "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
      args: [username, passwordHash, Date.now()],
    });
    const token = createAuthToken(Number(result.lastInsertRowid), username);
    res.status(201).json({ ok: true, token, username });
  } catch (err) {
    if (err.message?.includes("UNIQUE")) {
      res.status(409).json({ ok: false, error: "username-taken" });
    } else {
      console.error("Register error:", err);
      res.status(500).json({ ok: false, error: "server-error" });
    }
  }
});

router.post("/login", async (req, res) => {
  const { username, password } = req.body ?? {};
  if (!username || !password) {
    res.status(400).json({ ok: false, error: "username-and-password-required" });
    return;
  }

  const user = (await db.execute({
    sql: "SELECT * FROM users WHERE username = ?",
    args: [username],
  })).rows[0];

  if (!user) {
    res.status(401).json({ ok: false, error: "invalid-credentials" });
    return;
  }

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) {
    res.status(401).json({ ok: false, error: "invalid-credentials" });
    return;
  }

  const token = createAuthToken(Number(user.id), user.username);
  res.json({ ok: true, token, username: user.username });
});

export default router;
