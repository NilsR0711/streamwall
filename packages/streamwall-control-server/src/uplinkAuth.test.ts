import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { after, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'

import { buildTestApp } from './testHelpers.ts'

/**
 * Boots a listening control app and mints a streamwall uplink token, returning
 * the details needed to open an uplink WebSocket various ways.
 */
async function startUplinkServer() {
  process.env.STREAMWALL_RATE_LIMIT_MAX = '1000'
  const { app, auth } = await buildTestApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  after(() => app.close())
  const { port } = app.server.address() as AddressInfo

  const { tokenId, secret } = await auth.createToken({
    kind: 'streamwall',
    role: 'admin',
    name: 'test',
  })

  const path = `/streamwall/${tokenId}/ws`
  const base = `ws://127.0.0.1:${port}${path}`
  return { app, port, tokenId, secret, base }
}

/**
 * Captures the first app-level message from the moment the socket is created,
 * so an error the server sends immediately on connect is never missed to a
 * listener-attachment race. `next(timeoutMs)` resolves with that message or
 * null if none arrives within the window.
 */
function messageCollector(ws: WebSocket) {
  let first: unknown | undefined
  const received = new Promise<void>((resolve) => {
    ws.once('message', (data) => {
      first = JSON.parse(data.toString())
      resolve()
    })
  })
  return async (timeoutMs: number): Promise<unknown | null> => {
    await Promise.race([received, delay(timeoutMs)])
    return first === undefined ? null : first
  }
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
