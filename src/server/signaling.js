import { Hono } from 'hono'
import { requireAuth } from './middleware.js'

const SESSION_TTL_MS = 10 * 60 * 1000

function randomHex(bytes) {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('')
}

async function expireOldSessions(db) {
  const cutoff = Date.now() - SESSION_TTL_MS
  await db.batch([
    db.prepare(`
      DELETE FROM ice_candidates WHERE session_id IN (
        SELECT id FROM game_sessions
        WHERE status IN ('waiting','signaling') AND created_at < ?
      )
    `).bind(cutoff),
    db.prepare(
      "DELETE FROM game_sessions WHERE status IN ('waiting','signaling') AND created_at < ?"
    ).bind(cutoff),
  ])
}

const router = new Hono()

router.post('/sessions', requireAuth, async (c) => {
  const db = c.env.DB
  await expireOldSessions(db)

  const userId = c.get('auth').userId
  await db.batch([
    db.prepare(`
      DELETE FROM ice_candidates WHERE session_id IN (
        SELECT id FROM game_sessions WHERE host_user_id = ? AND status IN ('waiting','signaling')
      )
    `).bind(userId),
    db.prepare(
      "DELETE FROM game_sessions WHERE host_user_id = ? AND status IN ('waiting','signaling')"
    ).bind(userId),
  ])

  const id = randomHex(4)
  const now = Date.now()
  await db.prepare(
    `INSERT INTO game_sessions (id, host_user_id, status, created_at, updated_at) VALUES (?, ?, 'waiting', ?, ?)`
  ).bind(id, userId, now, now).run()

  return c.json({ ok: true, sessionId: id }, 201)
})

router.post('/sessions/:id/offer', requireAuth, async (c) => {
  const { sdp } = await c.req.json().catch(() => ({}))
  if (!sdp) return c.json({ ok: false, error: 'sdp-required' }, 400)

  const session = await c.env.DB
    .prepare('SELECT * FROM game_sessions WHERE id = ?')
    .bind(c.req.param('id')).first()
  if (!session) return c.json({ ok: false, error: 'not-found' }, 404)
  if (session.host_user_id !== c.get('auth').userId)
    return c.json({ ok: false, error: 'forbidden' }, 403)

  await c.env.DB.prepare(
    "UPDATE game_sessions SET offer_sdp = ?, status = 'signaling', updated_at = ? WHERE id = ?"
  ).bind(sdp, Date.now(), c.req.param('id')).run()

  return c.json({ ok: true })
})

router.get('/sessions/:id/offer', requireAuth, async (c) => {
  const session = await c.env.DB
    .prepare("SELECT offer_sdp FROM game_sessions WHERE id = ? AND status IN ('signaling','waiting')")
    .bind(c.req.param('id')).first()

  if (!session?.offer_sdp) return c.json({ ok: true, sdp: null })
  return c.json({ ok: true, sdp: session.offer_sdp })
})

router.post('/sessions/:id/answer', requireAuth, async (c) => {
  const { sdp } = await c.req.json().catch(() => ({}))
  if (!sdp) return c.json({ ok: false, error: 'sdp-required' }, 400)

  const session = await c.env.DB
    .prepare('SELECT * FROM game_sessions WHERE id = ?')
    .bind(c.req.param('id')).first()
  if (!session) return c.json({ ok: false, error: 'not-found' }, 404)
  if (session.host_user_id === c.get('auth').userId)
    return c.json({ ok: false, error: 'cannot-join-own-session' }, 400)
  if (session.guest_user_id && session.guest_user_id !== c.get('auth').userId)
    return c.json({ ok: false, error: 'session-full' }, 409)

  await c.env.DB.prepare(
    'UPDATE game_sessions SET answer_sdp = ?, guest_user_id = ?, updated_at = ? WHERE id = ?'
  ).bind(sdp, c.get('auth').userId, Date.now(), c.req.param('id')).run()

  return c.json({ ok: true })
})

router.get('/sessions/:id/answer', requireAuth, async (c) => {
  const session = await c.env.DB
    .prepare('SELECT answer_sdp FROM game_sessions WHERE id = ?')
    .bind(c.req.param('id')).first()

  if (!session) return c.json({ ok: false, error: 'not-found' }, 404)
  return c.json({ ok: true, sdp: session.answer_sdp ?? null })
})

router.post('/sessions/:id/ice', requireAuth, async (c) => {
  const { role, candidate } = await c.req.json().catch(() => ({}))
  if (!role || !candidate) return c.json({ ok: false, error: 'role-and-candidate-required' }, 400)
  if (role !== 'host' && role !== 'guest') return c.json({ ok: false, error: 'role-must-be-host-or-guest' }, 400)

  await c.env.DB.prepare(
    'INSERT INTO ice_candidates (session_id, from_role, candidate, delivered, created_at) VALUES (?, ?, ?, 0, ?)'
  ).bind(c.req.param('id'), role, JSON.stringify(candidate), Date.now()).run()

  return c.json({ ok: true })
})

router.get('/sessions/:id/ice/:for', requireAuth, async (c) => {
  const forRole = c.req.param('for')
  if (forRole !== 'host' && forRole !== 'guest') return c.json({ ok: false, error: 'invalid-role' }, 400)

  const { results: candidates } = await c.env.DB
    .prepare('SELECT id, candidate FROM ice_candidates WHERE session_id = ? AND from_role = ? AND delivered = 0')
    .bind(c.req.param('id'), forRole).all()

  if (candidates.length > 0) {
    const ids = candidates.map(row => row.id)
    await c.env.DB
      .prepare(`UPDATE ice_candidates SET delivered = 1 WHERE id IN (${ids.map(() => '?').join(',')})`)
      .bind(...ids).run()
  }

  return c.json({ ok: true, candidates: candidates.map(row => JSON.parse(row.candidate)) })
})

router.post('/sessions/:id/active', requireAuth, async (c) => {
  await c.env.DB.prepare(
    "UPDATE game_sessions SET status = 'active', updated_at = ? WHERE id = ? AND host_user_id = ?"
  ).bind(Date.now(), c.req.param('id'), c.get('auth').userId).run()
  return c.json({ ok: true })
})

router.post('/sessions/:id/end', requireAuth, async (c) => {
  await c.env.DB.prepare(
    "UPDATE game_sessions SET status = 'ended', updated_at = ? WHERE id = ?"
  ).bind(Date.now(), c.req.param('id')).run()
  return c.json({ ok: true })
})

export default router
