import { Hono } from 'hono'
import { requireAuth } from './middleware.js'

const router = new Hono()

function adminUsers(env) {
  return new Set(String(env.ADMIN_USERS ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean))
}

async function requireAdmin(c, next) {
  const allowed = adminUsers(c.env)
  if (allowed.size === 0) {
    return c.json({ ok: false, error: 'admin-not-configured' }, 403)
  }

  const auth = c.get('auth')
  const user = await c.env.DB
    .prepare('SELECT id, username, display_name, is_guest FROM users WHERE id = ?')
    .bind(auth.userId)
    .first()
  if (!user || user.is_guest || !allowed.has(String(user.username).toLowerCase())) {
    return c.json({ ok: false, error: 'admin-required' }, 403)
  }

  c.set('adminUser', user)
  await next()
}

async function tableCount(db, table) {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first()
  return Number(row?.count ?? 0)
}

router.use('/admin/*', requireAuth, requireAdmin)

router.get('/admin/summary', async (c) => {
  const db = c.env.DB
  const [users, guests, sessions, rounds, stats, enemies] = await Promise.all([
    tableCount(db, 'users'),
    db.prepare('SELECT COUNT(*) AS count FROM users WHERE is_guest = 1').first(),
    tableCount(db, 'game_sessions'),
    tableCount(db, 'round_results'),
    tableCount(db, 'player_stats'),
    tableCount(db, 'war_opponents'),
  ])

  const { results } = await db.prepare(`
    SELECT
      u.id,
      u.username,
      CASE
        WHEN u.is_guest = 1 AND u.display_name IS NOT NULL THEN u.display_name
        WHEN u.is_guest = 1 AND instr(u.username, '~') > 0 THEN substr(u.username, 1, instr(u.username, '~') - 1)
        ELSE COALESCE(u.display_name, u.username)
      END AS displayName,
      u.is_guest AS isGuest,
      u.created_at AS createdAt,
      COALESCE(ps.battles_won, 0) AS battlesWon,
      COALESCE(ps.battles_lost, 0) AS battlesLost,
      COALESCE(ps.wars_won, 0) AS warsWon,
      COALESCE(ps.wars_lost, 0) AS warsLost
    FROM users u
    LEFT JOIN player_stats ps ON ps.user_id = u.id
    ORDER BY u.created_at DESC
    LIMIT 250
  `).all()

  return c.json({
    ok: true,
    admin: c.get('adminUser').username,
    counts: {
      users,
      guests: Number(guests?.count ?? 0),
      sessions,
      rounds,
      stats,
      enemies,
    },
    users: results,
  })
})

router.delete('/admin/users/:id', async (c) => {
  const userId = Number(c.req.param('id'))
  if (!Number.isInteger(userId) || userId <= 0) {
    return c.json({ ok: false, error: 'invalid-user-id' }, 400)
  }

  const db = c.env.DB
  const user = await db.prepare('SELECT id, username FROM users WHERE id = ?').bind(userId).first()
  if (!user) return c.json({ ok: false, error: 'user-not-found' }, 404)

  await db.batch([
    db.prepare(`
      DELETE FROM ice_candidates
      WHERE session_id IN (
        SELECT id FROM game_sessions WHERE host_user_id = ? OR guest_user_id = ?
      )
    `).bind(userId, userId),
    db.prepare(`
      DELETE FROM round_results
      WHERE session_id IN (
        SELECT id FROM game_sessions WHERE host_user_id = ? OR guest_user_id = ?
      )
    `).bind(userId, userId),
    db.prepare(`
      DELETE FROM game_results
      WHERE session_id IN (
        SELECT id FROM game_sessions WHERE host_user_id = ? OR guest_user_id = ?
      )
    `).bind(userId, userId),
    db.prepare('DELETE FROM game_sessions WHERE host_user_id = ? OR guest_user_id = ?').bind(userId, userId),
    db.prepare('DELETE FROM round_results WHERE winner_user_id = ? OR loser_user_id = ?').bind(userId, userId),
    db.prepare('DELETE FROM game_results WHERE winner_user_id = ? OR loser_user_id = ?').bind(userId, userId),
    db.prepare('DELETE FROM war_opponents WHERE winner_user_id = ? OR loser_user_id = ?').bind(userId, userId),
    db.prepare('DELETE FROM player_stats WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM users WHERE id = ?').bind(userId),
  ])

  return c.json({ ok: true, deletedUser: user.username })
})

router.post('/admin/clear-game-data', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  if (body.confirm !== 'CLEAR GAME DATA') {
    return c.json({ ok: false, error: 'confirmation-required' }, 400)
  }

  const db = c.env.DB
  await db.batch([
    db.prepare('DELETE FROM ice_candidates'),
    db.prepare('DELETE FROM round_results'),
    db.prepare('DELETE FROM war_opponents'),
    db.prepare('DELETE FROM game_results'),
    db.prepare('DELETE FROM player_stats'),
    db.prepare('DELETE FROM game_sessions'),
  ])

  return c.json({ ok: true })
})

router.post('/admin/delete-guests', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  if (body.confirm !== 'DELETE GUESTS') {
    return c.json({ ok: false, error: 'confirmation-required' }, 400)
  }

  const db = c.env.DB
  await db.batch([
    db.prepare(`
      DELETE FROM ice_candidates
      WHERE session_id IN (
        SELECT gs.id
        FROM game_sessions gs
        JOIN users u ON u.id = gs.host_user_id OR u.id = gs.guest_user_id
        WHERE u.is_guest = 1
      )
    `),
    db.prepare(`
      DELETE FROM round_results
      WHERE session_id IN (
        SELECT gs.id
        FROM game_sessions gs
        JOIN users u ON u.id = gs.host_user_id OR u.id = gs.guest_user_id
        WHERE u.is_guest = 1
      )
    `),
    db.prepare(`
      DELETE FROM game_sessions
      WHERE host_user_id IN (SELECT id FROM users WHERE is_guest = 1)
         OR guest_user_id IN (SELECT id FROM users WHERE is_guest = 1)
    `),
    db.prepare('DELETE FROM round_results WHERE winner_user_id IN (SELECT id FROM users WHERE is_guest = 1) OR loser_user_id IN (SELECT id FROM users WHERE is_guest = 1)'),
    db.prepare('DELETE FROM game_results WHERE winner_user_id IN (SELECT id FROM users WHERE is_guest = 1) OR loser_user_id IN (SELECT id FROM users WHERE is_guest = 1)'),
    db.prepare('DELETE FROM war_opponents WHERE winner_user_id IN (SELECT id FROM users WHERE is_guest = 1) OR loser_user_id IN (SELECT id FROM users WHERE is_guest = 1)'),
    db.prepare('DELETE FROM player_stats WHERE user_id IN (SELECT id FROM users WHERE is_guest = 1)'),
    db.prepare('DELETE FROM users WHERE is_guest = 1'),
  ])

  return c.json({ ok: true })
})

export default router
