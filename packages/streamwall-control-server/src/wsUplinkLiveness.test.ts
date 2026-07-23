import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'
import { connectStreamwallUplink, startTestServer } from './testHelpers.ts'

// Liveness probing for the desktop uplink at `/streamwall/:id/ws`: a desktop
// that disappears without a TCP FIN never fires 'close' on its own, which
// would leave `ctx.currentStreamwallWs` occupied and block any reconnect.
// The cadence is injectable via `initApp({ uplinkPing })` (issue #635), so
// these specs run on short timers instead of the production 5s interval.

test('terminates an uplink that stops answering pings', async () => {
  const { auth, port, logs } = await startTestServer({
    uplinkPing: { intervalMs: 100, timeoutMs: 100 },
  })

  // `autoPong: false` makes the socket ignore incoming pings — the closest a
  // test can get to a peer that silently vanished mid-connection.
  const { ws } = await connectStreamwallUplink(auth, port, { autoPong: false })
  const closed = once(ws, 'close', { signal: AbortSignal.timeout(5000) })

  await logs.waitForMessage('Streamwall timeout: no pong within 100ms')
  await closed
  // The server-side 'close' handler released the uplink slot — this log line
  // is emitted right before `currentStreamwallWs` is cleared.
  await logs.waitForMessage('Streamwall disconnected')
})

test('keeps a responsive uplink connected across many ping cycles', async () => {
  const { auth, port, logs } = await startTestServer({
    uplinkPing: { intervalMs: 50, timeoutMs: 500 },
  })

  const { ws } = await connectStreamwallUplink(auth, port)
  // Span well over a handful of ping intervals; the ws library answers each
  // ping with a pong automatically, so the deadline never fires.
  await delay(400)

  assert.equal(ws.readyState, WebSocket.OPEN)
  assert.ok(
    !logs.hasMessage('Streamwall timeout'),
    'expected no liveness timeout',
  )
  assert.ok(!logs.hasMessage('Streamwall disconnected'))
})
