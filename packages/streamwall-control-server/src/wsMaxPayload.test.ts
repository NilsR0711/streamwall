import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'
import {
  buildTestApp,
  listenTestApp,
  mintUplinkToken,
  setEnvForTest,
  WIDE_RATE_LIMITS,
} from './testHelpers.ts'

/**
 * The server must cap per-frame memory at the WebSocket layer: without a
 * `maxPayload`, `ws` buffers up to 100 MiB per frame before any message-level
 * guard runs (issue #623). These specs pin the option to a small value via its
 * env override so the bound is observable without megabyte payloads.
 */
async function startStreamwallSocket(maxPayloadBytes: number) {
  setEnvForTest({
    STREAMWALL_WS_MAX_PAYLOAD_BYTES: String(maxPayloadBytes),
  })

  const { app, auth } = await buildTestApp({ rateLimit: WIDE_RATE_LIMITS })
  const port = await listenTestApp(app)
  const { base, secret } = await mintUplinkToken(auth, port)

  const ws = new WebSocket(base, {
    headers: { authorization: `Bearer ${secret}` },
  })
  await once(ws, 'open')

  return { app, ws }
}

test('closes a socket that sends a frame larger than the configured maxPayload', async () => {
  const { app, ws } = await startStreamwallSocket(1024)

  const closed = once(ws, 'close', { signal: AbortSignal.timeout(3000) })
  ws.send('x'.repeat(4096))

  const [code] = await closed
  assert.equal(code, 1009, 'expected a message-too-big close code')

  ws.terminate()
  await app.close()
})

test('keeps a socket open for frames within the configured maxPayload', async () => {
  const { app, ws } = await startStreamwallSocket(1024)

  ws.send('x'.repeat(512))
  await delay(250)

  assert.equal(ws.readyState, WebSocket.OPEN)

  ws.terminate()
  await app.close()
})
