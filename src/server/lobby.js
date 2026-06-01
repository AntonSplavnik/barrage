import { Hono } from 'hono'
import { requireAuth } from './middleware.js'

const router = new Hono()

router.get('/lobby', requireAuth, async (c) => {
  const { results } = await c.env.DB
    .prepare(`
      SELECT gs.id, COALESCE(u.display_name, u.username) AS hostUsername, gs.created_at AS createdAt
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
