import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type WebSocket from 'ws'
import * as Y from 'yjs'

import type { SentryCaptureClient } from './sentry.ts'
import {
  buildTestApp,
  connectStreamwallUplink,
  listenTestApp,
  redeemInviteAndConnectClient,
  VALID_STATE,
} from './testHelpers.ts'

/** Encodes a full-state update from a fresh doc mutated by `mutate`. */
function updateFrom(mutate: (doc: Y.Doc) => void): Uint8Array {
  const doc = new Y.Doc()
  doc.transact(() => mutate(doc))
  return Y.encodeStateAsUpdate(doc)
}

const BASE_URL = 'http://localhost:3000'

/**
 * `@fastify/websocket` bundles its own nested `ws` install
 * (`@fastify/websocket/node_modules/ws`), separate from the copy this
 * package imports directly. Every server-side socket in `initApp` is an
 * instance of *that* nested copy's `WebSocket` class, so mocking the
 * `WebSocket` this file imports would never intercept a server-side send.
 * Resolve the exact copy `@fastify/websocket` requires so the mock below
 * lands on the right prototype.
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
  process.env.STREAMWALL_RATE_LIMIT_MAX = '10000'
  process.env.STREAMWALL_AUTH_RATE_LIMIT_MAX = '10000'

  const sentryClient = fakeSentryClient()
  const { app, auth } = await buildTestApp({
    baseURL: BASE_URL,
    sentryEnabled: true,
    sentryClient,
  })
  t.after(() => app.close())
  const port = await listenTestApp(app)

  const { ws: streamwallWs } = await connectStreamwallUplink(auth, port)
  streamwallWs.send(JSON.stringify({ type: 'state', state: VALID_STATE }))
  await delay(150)

  await redeemInviteAndConnectClient(app, auth, port, BASE_URL, 'admin')
  await delay(50)

  // Force the next `ws.send()` carrying a state-delta payload to throw
  // synchronously, simulating the kind of internal `ws` send failure the
  // `failed to send client state delta` catch block guards against. Every
  // other `send()` call (initial handshake frames, Yjs doc updates, the
  // test's own client sockets, which use a different `ws` copy entirely)
  // passes through to the real implementation.
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

  const errorMock = t.mock.method(console, 'error')

  streamwallWs.send(
    JSON.stringify({
      type: 'state',
      state: { ...VALID_STATE, config: { ...VALID_STATE.config, cols: 4 } },
    }),
  )
  await delay(150)

  assert.equal(sentryClient.calls.length, 1)
  assert.equal(sentryClient.calls[0], sendError)

  const loggedCall = errorMock.mock.calls.find(
    (call) => call.arguments[0] === 'failed to send client state delta',
  )
  assert.ok(loggedCall, 'expected the send failure to be logged locally too')
  assert.equal(
    loggedCall?.arguments.at(-1),
    sendError,
    'the local log should include the caught error, not just the client',
  )
})

test('a synchronous ws.send() failure while relaying a doc update is reported to Sentry and logged locally for both the uplink and connected clients', async (t) => {
  process.env.STREAMWALL_RATE_LIMIT_MAX = '10000'
  process.env.STREAMWALL_AUTH_RATE_LIMIT_MAX = '10000'

  const sentryClient = fakeSentryClient()
  const { app, auth } = await buildTestApp({
    baseURL: BASE_URL,
    sentryEnabled: true,
    sentryClient,
  })
  t.after(() => app.close())
  const port = await listenTestApp(app)

  const { ws: streamwallWs } = await connectStreamwallUplink(auth, port)
  streamwallWs.send(JSON.stringify({ type: 'state', state: VALID_STATE }))
  await delay(150)

  await redeemInviteAndConnectClient(app, auth, port, BASE_URL, 'admin')
  await delay(50)

  // Force every subsequent binary (Yjs doc-update) send to throw, simulating
  // the kind of internal `ws` send failure the `Failed to send Streamwall doc
  // update` and `Failed to send client doc update:` catch blocks guard
  // against. JSON (text) frames pass through untouched.
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
      if (typeof data !== 'string') {
        throw sendError
      }
      return originalSend.apply(this, args)
    },
  )

  const errorMock = t.mock.method(console, 'error')

  streamwallWs.send(updateFrom((d) => d.getMap('test').set('a', 'b')))
  await delay(150)

  assert.equal(sentryClient.calls.length, 2)
  assert.equal(sentryClient.calls[0], sendError)
  assert.equal(sentryClient.calls[1], sendError)

  const uplinkCall = errorMock.mock.calls.find(
    (call) => call.arguments[0] === 'Failed to send Streamwall doc update',
  )
  assert.ok(uplinkCall, 'expected the uplink send failure to be logged')
  assert.equal(
    uplinkCall?.arguments.at(-1),
    sendError,
    'the local log should include the caught error',
  )

  const clientCall = errorMock.mock.calls.find(
    (call) => call.arguments[0] === 'Failed to send client doc update:',
  )
  assert.ok(clientCall, 'expected the client send failure to be logged')
  assert.equal(
    clientCall?.arguments.at(-1),
    sendError,
    'the local log should include the caught error, not just the client',
  )
})
