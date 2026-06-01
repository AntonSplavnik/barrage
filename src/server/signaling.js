import { Router } from "express";
import crypto from "node:crypto";
import db from "./db.js";
import { requireAuth } from "./auth.js";

const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes

function randomCode() {
  return crypto.randomBytes(4).toString("hex"); // e.g. "a1b2c3d4"
}

async function expireOldSessions() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  await db.execute({
    sql: `DELETE FROM ice_candidates WHERE session_id IN (
      SELECT id FROM game_sessions
      WHERE status IN ('waiting','signaling') AND created_at < ?
    )`,
    args: [cutoff],
  });
  await db.execute({
    sql: "DELETE FROM game_sessions WHERE status IN ('waiting','signaling') AND created_at < ?",
    args: [cutoff],
  });
}

const router = Router();

// P1: create a new game session (becomes the host)
router.post("/sessions", requireAuth, async (req, res) => {
  await expireOldSessions();

  // Only one active session per user at a time — delete ICE candidates first (FK constraint)
  await db.execute({
    sql: `DELETE FROM ice_candidates WHERE session_id IN (
      SELECT id FROM game_sessions WHERE host_user_id = ? AND status IN ('waiting','signaling')
    )`,
    args: [req.auth.userId],
  });
  await db.execute({
    sql: "DELETE FROM game_sessions WHERE host_user_id = ? AND status IN ('waiting','signaling')",
    args: [req.auth.userId],
  });

  const id = randomCode();
  const now = Date.now();
  await db.execute({
    sql: `INSERT INTO game_sessions (id, host_user_id, status, created_at, updated_at)
          VALUES (?, ?, 'waiting', ?, ?)`,
    args: [id, req.auth.userId, now, now],
  });

  res.status(201).json({ ok: true, sessionId: id });
});

// P1: post WebRTC offer SDP
router.post("/sessions/:id/offer", requireAuth, async (req, res) => {
  const { sdp } = req.body ?? {};
  if (!sdp) { res.status(400).json({ ok: false, error: "sdp-required" }); return; }

  const session = (await db.execute({
    sql: "SELECT * FROM game_sessions WHERE id = ?",
    args: [req.params.id],
  })).rows[0];

  if (!session) { res.status(404).json({ ok: false, error: "not-found" }); return; }
  if (session.host_user_id !== req.auth.userId) {
    res.status(403).json({ ok: false, error: "forbidden" });
    return;
  }

  await db.execute({
    sql: "UPDATE game_sessions SET offer_sdp = ?, status = 'signaling', updated_at = ? WHERE id = ?",
    args: [sdp, Date.now(), req.params.id],
  });

  res.json({ ok: true });
});

// P2: fetch offer SDP (polls until available)
router.get("/sessions/:id/offer", requireAuth, async (req, res) => {
  const session = (await db.execute({
    sql: "SELECT offer_sdp FROM game_sessions WHERE id = ? AND status IN ('signaling','waiting')",
    args: [req.params.id],
  })).rows[0];

  if (!session?.offer_sdp) {
    res.json({ ok: true, sdp: null });
    return;
  }
  res.json({ ok: true, sdp: session.offer_sdp });
});

// P2: post answer SDP + claim the guest slot
router.post("/sessions/:id/answer", requireAuth, async (req, res) => {
  const { sdp } = req.body ?? {};
  if (!sdp) { res.status(400).json({ ok: false, error: "sdp-required" }); return; }

  const session = (await db.execute({
    sql: "SELECT * FROM game_sessions WHERE id = ?",
    args: [req.params.id],
  })).rows[0];

  if (!session) { res.status(404).json({ ok: false, error: "not-found" }); return; }
  if (session.host_user_id === req.auth.userId) {
    res.status(400).json({ ok: false, error: "cannot-join-own-session" });
    return;
  }
  if (session.guest_user_id && session.guest_user_id !== req.auth.userId) {
    res.status(409).json({ ok: false, error: "session-full" });
    return;
  }

  await db.execute({
    sql: `UPDATE game_sessions SET answer_sdp = ?, guest_user_id = ?, updated_at = ? WHERE id = ?`,
    args: [sdp, req.auth.userId, Date.now(), req.params.id],
  });

  res.json({ ok: true });
});

// P1: fetch answer SDP (polls until P2 posts it)
router.get("/sessions/:id/answer", requireAuth, async (req, res) => {
  const session = (await db.execute({
    sql: "SELECT answer_sdp FROM game_sessions WHERE id = ?",
    args: [req.params.id],
  })).rows[0];

  if (!session) { res.status(404).json({ ok: false, error: "not-found" }); return; }
  res.json({ ok: true, sdp: session.answer_sdp ?? null });
});

// Both: post an ICE candidate
router.post("/sessions/:id/ice", requireAuth, async (req, res) => {
  const { role, candidate } = req.body ?? {};
  if (!role || !candidate) {
    res.status(400).json({ ok: false, error: "role-and-candidate-required" });
    return;
  }
  if (role !== "host" && role !== "guest") {
    res.status(400).json({ ok: false, error: "role-must-be-host-or-guest" });
    return;
  }

  await db.execute({
    sql: "INSERT INTO ice_candidates (session_id, from_role, candidate, delivered, created_at) VALUES (?, ?, ?, 0, ?)",
    args: [req.params.id, role, JSON.stringify(candidate), Date.now()],
  });

  res.json({ ok: true });
});

// Both: fetch pending ICE candidates (marks them delivered)
// :for = "host" means "candidates sent by host, for the guest to consume"
router.get("/sessions/:id/ice/:for", requireAuth, async (req, res) => {
  const forRole = req.params.for; // which side posted them
  if (forRole !== "host" && forRole !== "guest") {
    res.status(400).json({ ok: false, error: "invalid-role" });
    return;
  }

  const candidates = (await db.execute({
    sql: "SELECT id, candidate FROM ice_candidates WHERE session_id = ? AND from_role = ? AND delivered = 0",
    args: [req.params.id, forRole],
  })).rows;

  if (candidates.length > 0) {
    const ids = candidates.map((c) => c.id);
    await db.execute({
      sql: `UPDATE ice_candidates SET delivered = 1 WHERE id IN (${ids.map(() => "?").join(",")})`,
      args: ids,
    });
  }

  res.json({ ok: true, candidates: candidates.map((c) => JSON.parse(c.candidate)) });
});

// P1: mark session active once DataChannel is open
router.post("/sessions/:id/active", requireAuth, async (req, res) => {
  await db.execute({
    sql: "UPDATE game_sessions SET status = 'active', updated_at = ? WHERE id = ? AND host_user_id = ?",
    args: [Date.now(), req.params.id, req.auth.userId],
  });
  res.json({ ok: true });
});

// P1: mark session ended
router.post("/sessions/:id/end", requireAuth, async (req, res) => {
  await db.execute({
    sql: "UPDATE game_sessions SET status = 'ended', updated_at = ? WHERE id = ?",
    args: [Date.now(), req.params.id],
  });
  res.json({ ok: true });
});

export default router;
