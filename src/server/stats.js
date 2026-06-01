import { Router } from "express";
import db from "./db.js";
import { requireAuth } from "./auth.js";

const router = Router();

// Ensure a player_stats row exists for a non-guest user.
function ensureStats(userId) {
  db.prepare(
    "INSERT OR IGNORE INTO player_stats (user_id) VALUES (?)"
  ).run(userId);
}

// ---------------------------------------------------------------------------
// POST /api/sessions/:id/result
// Called by either player at the end of each round.
// Body: { roundNumber, winnerRole ("host"|"guest"), isFinal }
// Uses UNIQUE(session_id, round_number) to silently ignore duplicate reports.
// ---------------------------------------------------------------------------
router.post("/sessions/:id/result", requireAuth, (req, res) => {
  const { roundNumber, winnerRole, isFinal } = req.body ?? {};
  if (!roundNumber || !winnerRole) {
    res.status(400).json({ ok: false, error: "roundNumber-and-winnerRole-required" });
    return;
  }
  if (winnerRole !== "host" && winnerRole !== "guest") {
    res.status(400).json({ ok: false, error: "winnerRole-must-be-host-or-guest" });
    return;
  }

  const session = db.prepare(
    "SELECT host_user_id, guest_user_id FROM game_sessions WHERE id = ?"
  ).get(req.params.id);

  if (!session) {
    res.status(404).json({ ok: false, error: "session-not-found" });
    return;
  }

  // Verify the caller is part of this session
  const callerId = req.auth.userId;
  if (callerId !== session.host_user_id && callerId !== session.guest_user_id) {
    res.status(403).json({ ok: false, error: "forbidden" });
    return;
  }

  const winnerUserId = winnerRole === "host" ? session.host_user_id : session.guest_user_id;
  const loserUserId  = winnerRole === "host" ? session.guest_user_id : session.host_user_id;

  // Insert round result — silently ignore if already recorded (UNIQUE constraint)
  const insert = db.prepare(`
    INSERT OR IGNORE INTO round_results (session_id, round_number, winner_user_id, loser_user_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(req.params.id, roundNumber, winnerUserId ?? null, loserUserId ?? null, Date.now());

  // Only update stats if this is a new result (not a duplicate report)
  if (insert.changes > 0) {
    const recordBattle = db.transaction(() => {
      for (const [userId, won] of [[winnerUserId, true], [loserUserId, false]]) {
        if (!userId) continue;
        const user = db.prepare("SELECT is_guest FROM users WHERE id = ?").get(userId);
        if (!user || user.is_guest) continue; // skip guests
        ensureStats(userId);
        if (won) {
          db.prepare("UPDATE player_stats SET battles_won = battles_won + 1 WHERE user_id = ?").run(userId);
        } else {
          db.prepare("UPDATE player_stats SET battles_lost = battles_lost + 1 WHERE user_id = ?").run(userId);
        }
      }

      if (isFinal) {
        for (const [userId, won] of [[winnerUserId, true], [loserUserId, false]]) {
          if (!userId) continue;
          const user = db.prepare("SELECT is_guest FROM users WHERE id = ?").get(userId);
          if (!user || user.is_guest) continue;
          ensureStats(userId);
          if (won) {
            db.prepare("UPDATE player_stats SET wars_won = wars_won + 1 WHERE user_id = ?").run(userId);
          } else {
            db.prepare("UPDATE player_stats SET wars_lost = wars_lost + 1 WHERE user_id = ?").run(userId);
          }
        }

        // Record war_opponents entry (winner defeated loser)
        if (winnerUserId && loserUserId) {
          const wUser = db.prepare("SELECT is_guest FROM users WHERE id = ?").get(winnerUserId);
          if (wUser && !wUser.is_guest) {
            db.prepare(
              "INSERT INTO war_opponents (winner_user_id, loser_user_id, created_at) VALUES (?, ?, ?)"
            ).run(winnerUserId, loserUserId, Date.now());
          }
        }
      }
    });

    recordBattle();
  }

  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /api/leaderboard
// Returns all registered (non-guest) players sorted by wars_won desc.
// ---------------------------------------------------------------------------
router.get("/leaderboard", requireAuth, (_req, res) => {
  const rows = db.prepare(`
    SELECT
      COALESCE(u.display_name, u.username) AS username,
      COALESCE(ps.battles_won,  0) AS battles_won,
      COALESCE(ps.battles_lost, 0) AS battles_lost,
      COALESCE(ps.wars_won,     0) AS wars_won,
      COALESCE(ps.wars_lost,    0) AS wars_lost
    FROM users u
    LEFT JOIN player_stats ps ON ps.user_id = u.id
    WHERE u.is_guest = 0
    ORDER BY wars_won DESC, battles_won DESC, u.username ASC
  `).all();

  res.json({ ok: true, leaderboard: rows });
});

// ---------------------------------------------------------------------------
// GET /api/me/enemies
// Returns the list of opponents the current user has defeated in wars.
// ---------------------------------------------------------------------------
router.get("/me/enemies", requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT COALESCE(u.display_name, u.username) AS username, wo.created_at AS defeatedAt
    FROM war_opponents wo
    JOIN users u ON u.id = wo.loser_user_id
    WHERE wo.winner_user_id = ?
    ORDER BY wo.created_at DESC
  `).all(req.auth.userId);

  res.json({ ok: true, enemies: rows });
});

export default router;
