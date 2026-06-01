import { SignJWT, jwtVerify } from 'jose'

function jwtSecret(env) {
  return new TextEncoder().encode(env.JWT_SECRET ?? 'change-me-in-production')
}

export async function createAuthToken(userId, username, env) {
  return new SignJWT({ userId, username })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('7d')
    .sign(jwtSecret(env))
}

export async function requireAuth(c, next) {
  const header = c.req.header('Authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return c.json({ ok: false, error: 'auth-required' }, 401)
  try {
    const { payload } = await jwtVerify(token, jwtSecret(c.env))
    c.set('auth', payload)
    await next()
  } catch {
    return c.json({ ok: false, error: 'invalid-token' }, 401)
  }
}
