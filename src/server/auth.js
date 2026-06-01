import { Hono } from 'hono'
import bcrypt from 'bcryptjs'
import { createAuthToken, requireAuth } from './middleware.js'

const SALT_ROUNDS = 10

function validateUsername(username) {
  if (!username || username.length < 2 || username.length > 24) return 'username-length'
  if (!/^[a-zA-Z0-9_\-]+$/.test(username)) return 'username-invalid-chars'
  return null
}

function randomHex(bytes) {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('')
}

const router = new Hono()

router.post('/quickplay', async (c) => {
  const { name } = await c.req.json().catch(() => ({}))
  const err = validateUsername(name)
  if (err) return c.json({ ok: false, error: err }, 400)

  const suffix = randomHex(3)
  const storedUsername = `${name}~${suffix}`
  const now = Date.now()

  const result = await c.env.DB
    .prepare('INSERT INTO users (username, display_name, is_guest, password_hash, created_at) VALUES (?, ?, 1, ?, ?)')
    .bind(storedUsername, name, '', now)
    .run()

  const token = await createAuthToken(result.meta.last_row_id, name, c.env)
  return c.json({ ok: true, token, username: name }, 201)
})

router.post('/register', async (c) => {
  const { username, password } = await c.req.json().catch(() => ({}))
  if (!username || !password) return c.json({ ok: false, error: 'username-and-password-required' }, 400)
  const usernameErr = validateUsername(username)
  if (usernameErr) return c.json({ ok: false, error: usernameErr }, 400)
  if (password.length < 6) return c.json({ ok: false, error: 'password-too-short' }, 400)

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS)
  try {
    const result = await c.env.DB
      .prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
      .bind(username, passwordHash, Date.now())
      .run()
    const token = await createAuthToken(result.meta.last_row_id, username, c.env)
    return c.json({ ok: true, token, username }, 201)
  } catch (err) {
    if (err.message?.includes('UNIQUE')) return c.json({ ok: false, error: 'username-taken' }, 409)
    console.error('Register error:', err)
    return c.json({ ok: false, error: 'server-error' }, 500)
  }
})

router.post('/login', async (c) => {
  const { username, password } = await c.req.json().catch(() => ({}))
  if (!username || !password) return c.json({ ok: false, error: 'username-and-password-required' }, 400)

  const user = await c.env.DB
    .prepare('SELECT * FROM users WHERE username = ?')
    .bind(username)
    .first()

  if (!user) return c.json({ ok: false, error: 'invalid-credentials' }, 401)

  const match = await bcrypt.compare(password, user.password_hash)
  if (!match) return c.json({ ok: false, error: 'invalid-credentials' }, 401)

  const token = await createAuthToken(user.id, user.username, c.env)
  return c.json({ ok: true, token, username: user.username })
})

export default router
