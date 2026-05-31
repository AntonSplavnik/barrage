import { Router } from "express";
import db from "./db.js";
import { requireAuth } from "./auth.js";

const router = Router();

router.get("/lobby", requireAuth, (req, res) => {
  const sessions = db.prepare(`
    SELECT gs.id, COALESCE(u.display_name, u.username) AS hostUsername, gs.created_at AS createdAt
    FROM game_sessions gs
    JOIN users u ON u.id = gs.host_user_id
    WHERE gs.status IN ('waiting', 'signaling')
      AND gs.guest_user_id IS NULL
      AND gs.host_user_id != ?
    ORDER BY gs.created_at DESC
    LIMIT 20
  `).all(req.auth.userId);

  res.json({ ok: true, sessions });
});

export default router;
