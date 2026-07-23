import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'
import { bootServerWithUplink } from './testHelpers.ts'

// Liveness probing for `/client/ws` (issue #618): a browser that disappears
// without a TCP FIN never fires 'close', so without a pong deadline its
// registry entry would leak and keep receiving every broadcast forever.

test('terminates a client that stops answering pings', async () => {
  const { logs, connectClient } = await bootServerWithUplink({
    clientPing: { intervalMs: 100, timeoutMs: 100 },
  })

  // `autoPong: false` makes the socket ignore incoming pings — the closest a
  // test can get to a peer that silently vanished mid-connection.
  const { clientWs } = await connectClient('admin', { autoPong: false })
  const closed = once(clientWs, 'close', { signal: AbortSignal.timeout(5000) })

  await logs.waitForMessage('Client timeout: no pong within 100ms')
  await closed
  // The server-side 'close' handler removed the client from the broadcast
  // registry — this log line is emitted right after the map deletion.
  await logs.waitForMessage('Client disconnected')
})

test('keeps a responsive client connected across many ping cycles', async () => {
  const { logs, connectClient } = await bootServerWithUplink({
    clientPing: { intervalMs: 50, timeoutMs: 500 },
  })

  const { clientWs } = await connectClient()
  // Span well over a handful of ping intervals; the ws library answers each
  // ping with a pong automatically, so the deadline never fires.
  await delay(400)

  assert.equal(clientWs.readyState, WebSocket.OPEN)
  assert.ok(!logs.hasMessage('Client timeout'), 'expected no liveness timeout')
  assert.ok(!logs.hasMessage('Client disconnected'))
})
