import { Hono } from 'hono'
import { requireAuth } from './middleware.js'

const router = new Hono()

router.get('/lobby', requireAuth, async (c) => {
  const { results } = await c.env.DB
    .prepare(`
      SELECT
        gs.id,
        CASE
          WHEN u.is_guest = 1 AND u.display_name IS NOT NULL THEN u.display_name
          WHEN u.is_guest = 1 AND instr(u.username, '~') > 0 THEN substr(u.username, 1, instr(u.username, '~') - 1)
          ELSE COALESCE(u.display_name, u.username)
        END AS hostUsername,
        gs.created_at AS createdAt
      FROM game_sessions gs
      JOIN users u ON u.id = gs.host_user_id
      WHERE gs.status IN ('waiting', 'signaling')
        AND gs.guest_user_id IS NULL
        AND gs.host_user_id != ?
      ORDER BY gs.created_at DESC
      LIMIT 20
    `)
    .bind(c.get('auth').userId)
    .all()

  return c.json({ ok: true, sessions: results })
})

export default router
