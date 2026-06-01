import { Hono } from 'hono'
import { handle } from 'hono/cloudflare-pages'
import authRouter from '../../src/server/auth.js'
import lobbyRouter from '../../src/server/lobby.js'
import signalingRouter from '../../src/server/signaling.js'
import statsRouter from '../../src/server/stats.js'

const app = new Hono().basePath('/api')

app.route('/', authRouter)
app.route('/', lobbyRouter)
app.route('/', signalingRouter)
app.route('/', statsRouter)

app.onError((err, c) => {
  console.error('[api error]', err.message)
  return c.json({ ok: false, error: 'server-error' }, 500)
})

export const onRequest = handle(app)
