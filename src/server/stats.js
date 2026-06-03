import { Hono } from 'hono'
import { requireAuth } from './middleware.js'

const router = new Hono()

router.post('/sessions/:id/result', requireAuth, async (c) => {
  const { roundNumber, winnerRole, isFinal } = await c.req.json().catch(() => ({}))
  if (!roundNumber || !winnerRole)
    return c.json({ ok: false, error: 'roundNumber-and-winnerRole-required' }, 400)
  if (winnerRole !== 'host' && winnerRole !== 'guest')
    return c.json({ ok: false, error: 'winnerRole-must-be-host-or-guest' }, 400)

  const db = c.env.DB
  const session = await db
    .prepare('SELECT host_user_id, guest_user_id FROM game_sessions WHERE id = ?')
    .bind(c.req.param('id')).first()
  if (!session) return c.json({ ok: false, error: 'session-not-found' }, 404)

  const callerId = c.get('auth').userId
  if (callerId !== session.host_user_id && callerId !== session.guest_user_id)
    return c.json({ ok: false, error: 'forbidden' }, 403)

  const winnerUserId = winnerRole === 'host' ? session.host_user_id : session.guest_user_id
  const loserUserId  = winnerRole === 'host' ? session.guest_user_id : session.host_user_id

  // UNIQUE(session_id, round_number) silently ignores duplicate reports
  const insert = await db.prepare(`
    INSERT OR IGNORE INTO round_results (session_id, round_number, winner_user_id, loser_user_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(c.req.param('id'), roundNumber, winnerUserId ?? null, loserUserId ?? null, Date.now()).run()

  if (insert.meta.changes > 0) {
    for (const [userId, won] of [[winnerUserId, true], [loserUserId, false]]) {
      if (!userId) continue
      const user = await db.prepare('SELECT is_guest FROM users WHERE id = ?').bind(userId).first()
      if (!user || user.is_guest) continue
      await db.prepare('INSERT OR IGNORE INTO player_stats (user_id) VALUES (?)').bind(userId).run()
      await db.prepare(
        won
          ? 'UPDATE player_stats SET battles_won = battles_won + 1 WHERE user_id = ?'
          : 'UPDATE player_stats SET battles_lost = battles_lost + 1 WHERE user_id = ?'
      ).bind(userId).run()
    }

    if (isFinal) {
      for (const [userId, won] of [[winnerUserId, true], [loserUserId, false]]) {
        if (!userId) continue
        const user = await db.prepare('SELECT is_guest FROM users WHERE id = ?').bind(userId).first()
        if (!user || user.is_guest) continue
        await db.prepare('INSERT OR IGNORE INTO player_stats (user_id) VALUES (?)').bind(userId).run()
        await db.prepare(
          won
            ? 'UPDATE player_stats SET wars_won = wars_won + 1 WHERE user_id = ?'
            : 'UPDATE player_stats SET wars_lost = wars_lost + 1 WHERE user_id = ?'
        ).bind(userId).run()
      }

      if (winnerUserId && loserUserId) {
        const wUser = await db.prepare('SELECT is_guest FROM users WHERE id = ?').bind(winnerUserId).first()
        if (wUser && !wUser.is_guest) {
          await db.prepare(
            'INSERT INTO war_opponents (winner_user_id, loser_user_id, created_at) VALUES (?, ?, ?)'
          ).bind(winnerUserId, loserUserId, Date.now()).run()
        }
      }
    }
  }

  return c.json({ ok: true })
})

router.get('/leaderboard', requireAuth, async (c) => {
  const { results } = await c.env.DB.prepare(`
    SELECT
      CASE
        WHEN u.is_guest = 1 AND u.display_name IS NOT NULL THEN u.display_name
        WHEN u.is_guest = 1 AND instr(u.username, '~') > 0 THEN substr(u.username, 1, instr(u.username, '~') - 1)
        ELSE COALESCE(u.display_name, u.username)
      END AS username,
      COALESCE(ps.battles_won,  0) AS battles_won,
      COALESCE(ps.battles_lost, 0) AS battles_lost,
      COALESCE(ps.wars_won,     0) AS wars_won,
      COALESCE(ps.wars_lost,    0) AS wars_lost
    FROM users u
    LEFT JOIN player_stats ps ON ps.user_id = u.id
    WHERE u.is_guest = 0
    ORDER BY wars_won DESC, battles_won DESC, u.username ASC
  `).all()

  return c.json({ ok: true, leaderboard: results })
})

router.get('/me/enemies', requireAuth, async (c) => {
  const { results } = await c.env.DB.prepare(`
    SELECT
      CASE
        WHEN u.is_guest = 1 AND u.display_name IS NOT NULL THEN u.display_name
        WHEN u.is_guest = 1 AND instr(u.username, '~') > 0 THEN substr(u.username, 1, instr(u.username, '~') - 1)
        ELSE COALESCE(u.display_name, u.username)
      END AS username,
      wo.created_at AS defeatedAt
    FROM war_opponents wo
    JOIN users u ON u.id = wo.loser_user_id
    WHERE wo.winner_user_id = ?
    ORDER BY wo.created_at DESC
  `).bind(c.get('auth').userId).all()

  return c.json({ ok: true, enemies: results })
})

export default router
