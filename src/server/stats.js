import { Router } from "express";
import db from "./db.js";
import { requireAuth } from "./auth.js";

const router = Router();

async function ensureStats(tx, userId) {
  await tx.execute({
    sql: "INSERT OR IGNORE INTO player_stats (user_id) VALUES (?)",
    args: [userId],
  });
}

// ---------------------------------------------------------------------------
// POST /api/sessions/:id/result
// Called by either player at the end of each round.
// Body: { roundNumber, winnerRole ("host"|"guest"), isFinal }
// Uses UNIQUE(session_id, round_number) to silently ignore duplicate reports.
// ---------------------------------------------------------------------------
router.post("/sessions/:id/result", requireAuth, async (req, res) => {
  const { roundNumber, winnerRole, isFinal } = req.body ?? {};
  if (!roundNumber || !winnerRole) {
    res.status(400).json({ ok: false, error: "roundNumber-and-winnerRole-required" });
    return;
  }
  if (winnerRole !== "host" && winnerRole !== "guest") {
    res.status(400).json({ ok: false, error: "winnerRole-must-be-host-or-guest" });
    return;
  }

  const session = (await db.execute({
    sql: "SELECT host_user_id, guest_user_id FROM game_sessions WHERE id = ?",
    args: [req.params.id],
  })).rows[0];

  if (!session) {
    res.status(404).json({ ok: false, error: "session-not-found" });
    return;
  }

  const callerId = req.auth.userId;
  if (callerId !== session.host_user_id && callerId !== session.guest_user_id) {
    res.status(403).json({ ok: false, error: "forbidden" });
    return;
  }

  const winnerUserId = winnerRole === "host" ? session.host_user_id : session.guest_user_id;
  const loserUserId  = winnerRole === "host" ? session.guest_user_id : session.host_user_id;

  // Insert round result — silently ignore if already recorded (UNIQUE constraint)
  const insert = await db.execute({
    sql: `INSERT OR IGNORE INTO round_results (session_id, round_number, winner_user_id, loser_user_id, created_at)
          VALUES (?, ?, ?, ?, ?)`,
    args: [req.params.id, roundNumber, winnerUserId ?? null, loserUserId ?? null, Date.now()],
  });

  // Only update stats if this is a new result (not a duplicate report)
  if (insert.rowsAffected > 0) {
    const tx = await db.transaction("write");
    try {
      for (const [userId, won] of [[winnerUserId, true], [loserUserId, false]]) {
        if (!userId) continue;
        const user = (await tx.execute({
          sql: "SELECT is_guest FROM users WHERE id = ?",
          args: [userId],
        })).rows[0];
        if (!user || user.is_guest) continue;
        await ensureStats(tx, userId);
        if (won) {
          await tx.execute({
            sql: "UPDATE player_stats SET battles_won = battles_won + 1 WHERE user_id = ?",
            args: [userId],
          });
        } else {
          await tx.execute({
            sql: "UPDATE player_stats SET battles_lost = battles_lost + 1 WHERE user_id = ?",
            args: [userId],
          });
        }
      }

      if (isFinal) {
        for (const [userId, won] of [[winnerUserId, true], [loserUserId, false]]) {
          if (!userId) continue;
          const user = (await tx.execute({
            sql: "SELECT is_guest FROM users WHERE id = ?",
            args: [userId],
          })).rows[0];
          if (!user || user.is_guest) continue;
          await ensureStats(tx, userId);
          if (won) {
            await tx.execute({
              sql: "UPDATE player_stats SET wars_won = wars_won + 1 WHERE user_id = ?",
              args: [userId],
            });
          } else {
            await tx.execute({
              sql: "UPDATE player_stats SET wars_lost = wars_lost + 1 WHERE user_id = ?",
              args: [userId],
            });
          }
        }

        if (winnerUserId && loserUserId) {
          const wUser = (await tx.execute({
            sql: "SELECT is_guest FROM users WHERE id = ?",
            args: [winnerUserId],
          })).rows[0];
          if (wUser && !wUser.is_guest) {
            await tx.execute({
              sql: "INSERT INTO war_opponents (winner_user_id, loser_user_id, created_at) VALUES (?, ?, ?)",
              args: [winnerUserId, loserUserId, Date.now()],
            });
          }
        }
      }

      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  }

  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /api/leaderboard
// Returns all registered (non-guest) players sorted by wars_won desc.
// ---------------------------------------------------------------------------
router.get("/leaderboard", requireAuth, async (_req, res) => {
  const result = await db.execute(`
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
  `);

  res.json({ ok: true, leaderboard: result.rows });
});

// ---------------------------------------------------------------------------
// GET /api/me/enemies
// Returns the list of opponents the current user has defeated in wars.
// ---------------------------------------------------------------------------
router.get("/me/enemies", requireAuth, async (req, res) => {
  const result = await db.execute({
    sql: `SELECT COALESCE(u.display_name, u.username) AS username, wo.created_at AS defeatedAt
          FROM war_opponents wo
          JOIN users u ON u.id = wo.loser_user_id
          WHERE wo.winner_user_id = ?
          ORDER BY wo.created_at DESC`,
    args: [req.auth.userId],
  });

  res.json({ ok: true, enemies: result.rows });
});

export default router;
