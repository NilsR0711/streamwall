import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import type WebSocket from 'ws'
import * as Y from 'yjs'

import type { SentryCaptureClient } from './sentry.ts'
import {
  buildTestApp,
  captureLogs,
  connectStreamwallUplink,
  listenTestApp,
  redeemInviteAndConnectClient,
  VALID_STATE,
  WIDE_RATE_LIMITS,
} from './testHelpers.ts'

/** Encodes a full-state update from a fresh doc mutated by `mutate`. */
function updateFrom(mutate: (doc: Y.Doc) => void): Uint8Array {
  const doc = new Y.Doc()
  doc.transact(() => mutate(doc))
  return Y.encodeStateAsUpdate(doc)
}

const BASE_URL = 'http://localhost:3000'

/** Reads the message off pino's serialized `err` field of a log entry. */
function loggedErrorMessage(entry: Record<string, unknown>) {
  return (entry.err as { message?: string } | undefined)?.message
}

/**
 * Every server-side socket in `initApp` is an instance of the `WebSocket`
 * class from the `ws` copy `@fastify/websocket` requires, which npm may or
 * may not dedupe with the copy this package imports directly. Resolve that
 * exact copy so the mocks below always land on the right prototype.
 *
 * When the two installs *are* deduped, the mocked prototype is shared with
 * the test's own client sockets, so a mock must never key off the socket
 * class alone — see the send filters in the tests below.
 */
const localRequire = createRequire(import.meta.url)
const requireFromFastifyWebsocket = createRequire(
  localRequire.resolve('@fastify/websocket'),
)
const wsModule = requireFromFastifyWebsocket('ws')
const ServerWebSocket: typeof WebSocket = wsModule.WebSocket ?? wsModule

/** Records every error passed to `captureException`. */
function fakeSentryClient(): SentryCaptureClient & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    calls,
    captureException(err: unknown) {
      calls.push(err)
      return 'fake-event-id'
    },
  }
}

test('a synchronous ws.send() failure while broadcasting a state delta is reported to Sentry', async (t) => {
  const sentryClient = fakeSentryClient()
  const logs = captureLogs()
  const { app, auth } = await buildTestApp({
    baseURL: BASE_URL,
    sentryEnabled: true,
    sentryClient,
    logs,
    rateLimit: WIDE_RATE_LIMITS,
  })
  t.after(() => app.close())
  const port = await listenTestApp(app)

  const { ws: streamwallWs } = await connectStreamwallUplink(auth, port)
  streamwallWs.send(JSON.stringify({ type: 'state', state: VALID_STATE }))
  await logs.waitForMessage('Streamwall connected')

  await redeemInviteAndConnectClient(app, auth, port, BASE_URL, 'admin')
  await logs.waitForMessage('Client connected')

  // Force the next `ws.send()` carrying a state-delta payload to throw
  // synchronously, simulating the kind of internal `ws` send failure the
  // `failed to send client state delta` catch block guards against. Every
  // other `send()` call (initial handshake frames, Yjs doc updates, and
  // anything the test's own client sockets send) passes through to the real
  // implementation: only the server emits `state-delta` frames.
  const originalSend: typeof WebSocket.prototype.send =
    ServerWebSocket.prototype.send
  const sendError = new Error('boom - forced send failure')
  t.mock.method(
    ServerWebSocket.prototype,
    'send',
    function (
      this: WebSocket,
      ...args: Parameters<typeof WebSocket.prototype.send>
    ) {
      const [data] = args
      if (typeof data === 'string' && data.includes('"state-delta"')) {
        throw sendError
      }
      return originalSend.apply(this, args)
    },
  )

  streamwallWs.send(
    JSON.stringify({
      type: 'state',
      state: { ...VALID_STATE, config: { ...VALID_STATE.config, cols: 4 } },
    }),
  )
  // The local log entry is the observable signal that the failure was caught;
  // waiting for it doubles as the assertion that it is logged at all.
  const logged = await logs.waitForMessage('Failed to send client state delta')

  assert.equal(sentryClient.calls.length, 1)
  assert.equal(sentryClient.calls[0], sendError)

  assert.equal(
    loggedErrorMessage(logged),
    sendError.message,
    'the local log should include the caught error, not just the client',
  )
})

test('a synchronous ws.send() failure while relaying a doc update is reported to Sentry and logged locally for both the uplink and connected clients', async (t) => {
  const sentryClient = fakeSentryClient()
  const logs = captureLogs()
  const { app, auth } = await buildTestApp({
    baseURL: BASE_URL,
    sentryEnabled: true,
    sentryClient,
    logs,
    rateLimit: WIDE_RATE_LIMITS,
  })
  t.after(() => app.close())
  const port = await listenTestApp(app)

  const { ws: streamwallWs } = await connectStreamwallUplink(auth, port)
  streamwallWs.send(JSON.stringify({ type: 'state', state: VALID_STATE }))
  await logs.waitForMessage('Streamwall connected')

  const { ws: clientWs } = await redeemInviteAndConnectClient(
    app,
    auth,
    port,
    BASE_URL,
    'admin',
  )
  await logs.waitForMessage('Client connected')

  // Force every subsequent server-side binary (Yjs doc-update) send to throw,
  // simulating the kind of internal `ws` send failure the `Failed to send
  // Streamwall doc update` and `Failed to send client doc update:` catch
  // blocks guard against. JSON (text) frames pass through untouched, as do
  // the test's own client sockets — which share this prototype whenever npm
  // dedupes the two `ws` installs, and whose doc-update send is what drives
  // the scenario in the first place.
  const testSockets: unknown[] = [streamwallWs, clientWs]
  const originalSend: typeof WebSocket.prototype.send =
    ServerWebSocket.prototype.send
  const sendError = new Error('boom - forced doc update send failure')
  t.mock.method(
    ServerWebSocket.prototype,
    'send',
    function (
      this: WebSocket,
      ...args: Parameters<typeof WebSocket.prototype.send>
    ) {
      const [data] = args
      if (typeof data !== 'string' && !testSockets.includes(this)) {
        throw sendError
      }
      return originalSend.apply(this, args)
    },
  )

  streamwallWs.send(updateFrom((d) => d.getMap('test').set('a', 'b')))
  // Both relay paths fail independently; wait for each to have been logged
  // rather than for a fixed window that may or may not cover them.
  const uplinkEntry = await logs.waitForMessage(
    'Failed to send Streamwall doc update',
  )
  const clientEntry = await logs.waitForMessage(
    'Failed to send client doc update',
  )

  assert.equal(sentryClient.calls.length, 2)
  assert.equal(sentryClient.calls[0], sendError)
  assert.equal(sentryClient.calls[1], sendError)

  assert.equal(
    loggedErrorMessage(uplinkEntry),
    sendError.message,
    'the local log should include the caught error',
  )

  assert.equal(
    loggedErrorMessage(clientEntry),
    sendError.message,
    'the local log should include the caught error, not just the client',
  )
})
