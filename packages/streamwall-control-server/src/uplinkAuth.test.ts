import assert from 'node:assert/strict'
import { once } from 'node:events'
import { after, test } from 'node:test'
import WebSocket from 'ws'

import {
  buildTestApp,
  listenTestApp,
  messageCollector,
  mintUplinkToken,
  WIDE_RATE_LIMITS,
} from './testHelpers.ts'

/**
 * Boots a listening control app and mints a streamwall uplink token, returning
 * the details needed to open an uplink WebSocket various ways.
 */
async function startUplinkServer() {
  const { app, auth } = await buildTestApp({ rateLimit: WIDE_RATE_LIMITS })
  const port = await listenTestApp(app)
  after(() => app.close())
  const { tokenId, secret, base } = await mintUplinkToken(auth, port)
  return { app, port, tokenId, secret, base }
}

// Rejections run an async scrypt verification before the error is sent, so
// negative cases wait generously; the positive case only needs a short window
// to confirm the server stays silent.
const REJECTION_WINDOW_MS = 2000
const SILENCE_WINDOW_MS = 500

test('accepts an uplink authenticated via the Authorization header', async () => {
  const { base, secret } = await startUplinkServer()

  const ws = new WebSocket(base, {
    headers: { authorization: `Bearer ${secret}` },
  })
  after(() => ws.terminate())
  const nextMessage = messageCollector(ws)
  await once(ws, 'open')

  assert.equal(
    await nextMessage(SILENCE_WINDOW_MS),
    null,
    'an authorized uplink receives no error and stays connected',
  )
  assert.equal(ws.readyState, WebSocket.OPEN)
})

test('rejects an uplink that presents its secret only in the query string', async () => {
  const { base, secret } = await startUplinkServer()

  const ws = new WebSocket(`${base}?token=${secret}`)
  after(() => ws.terminate())
  const nextMessage = messageCollector(ws)

  assert.deepEqual(
    await nextMessage(REJECTION_WINDOW_MS),
    { error: 'unauthorized' },
    'the query-string token path must no longer authenticate',
  )
})

test('rejects an uplink with no credentials', async () => {
  const { base } = await startUplinkServer()

  const ws = new WebSocket(base)
  after(() => ws.terminate())
  const nextMessage = messageCollector(ws)

  assert.deepEqual(await nextMessage(REJECTION_WINDOW_MS), {
    error: 'unauthorized',
  })
})

test('rejects an uplink whose Authorization header carries a wrong secret', async () => {
  const { base } = await startUplinkServer()

  const ws = new WebSocket(base, {
    headers: { authorization: 'Bearer not-the-secret' },
  })
  after(() => ws.terminate())
  const nextMessage = messageCollector(ws)

  assert.deepEqual(await nextMessage(REJECTION_WINDOW_MS), {
    error: 'unauthorized',
  })
})
