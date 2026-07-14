import assert from 'node:assert/strict'
import { once } from 'node:events'
import { after, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type {
  ClientCommandResponse,
  ClientErrorMessage,
  ControlCommandMessage,
  ServerToClientMessage,
  StreamwallRole,
} from 'streamwall-shared'
import * as Y from 'yjs'
import {
  buildTestApp,
  connectStreamwallUplink,
  listenTestApp,
  redeemInviteAndConnectClient,
  VALID_STATE,
} from './testHelpers.ts'

const BASE_URL = 'http://localhost:3000'

/** Narrows to the server's reply to the client command with the given `id`. */
function isResponseTo(id: number) {
  return (m: ServerToClientMessage): m is ClientCommandResponse =>
    'response' in m && m.response === true && m.id === id
}

/** Narrows to a forwarded control command of the given `type`. */
function isCommandType<Type extends ControlCommandMessage['type']>(type: Type) {
  return (
    m: ControlCommandMessage,
  ): m is Extract<ControlCommandMessage, { type: Type }> => m.type === type
}

/** Narrows to a bare connection-level rejection (never has `response`). */
const isBareError = (m: ServerToClientMessage): m is ClientErrorMessage =>
  !('response' in m) && 'error' in m

// A per-test override of the update cap must not leak into other test files.
after(() => {
  delete process.env.STREAMWALL_WS_UPDATE_MAX_BYTES
})

/**
 * Boots a live server, connects a Streamwall uplink and seeds a state message,
 * then redeems an invite and opens an authenticated client socket. JSON frames
 * from both sockets are recorded from the moment they open.
 */
async function connectStreamwallAndClient({
  stateMessage = { type: 'state', state: VALID_STATE } as Record<
    string,
    unknown
  >,
  role = 'admin' as StreamwallRole,
  wsUpdateMaxBytes,
}: {
  stateMessage?: Record<string, unknown>
  role?: StreamwallRole
  wsUpdateMaxBytes?: number
} = {}) {
  process.env.STREAMWALL_RATE_LIMIT_MAX = '10000'
  process.env.STREAMWALL_AUTH_RATE_LIMIT_MAX = '10000'
  if (wsUpdateMaxBytes !== undefined) {
    process.env.STREAMWALL_WS_UPDATE_MAX_BYTES = String(wsUpdateMaxBytes)
  } else {
    delete process.env.STREAMWALL_WS_UPDATE_MAX_BYTES
  }

  const { app, auth } = await buildTestApp({ baseURL: BASE_URL })
  after(() => app.close())
  const port = await listenTestApp(app)

  const { ws: streamwallWs, streamwall } = await connectStreamwallUplink(
    auth,
    port,
  )
  streamwallWs.send(JSON.stringify(stateMessage))
  await delay(150)

  const { ws: clientWs, client } = await redeemInviteAndConnectClient(
    app,
    auth,
    port,
    BASE_URL,
    role,
  )

  return { app, auth, streamwallWs, clientWs, streamwall, client }
}

test('does not forward an out-of-bounds command to the Streamwall uplink', async () => {
  const { clientWs, streamwall } = await connectStreamwallAndClient()

  // Invalid: viewIdx is negative (outside the bounded range).
  clientWs.send(JSON.stringify({ id: 10, type: 'reload-view', viewIdx: -5 }))
  // Valid: a well-formed command that must reach the uplink.
  clientWs.send(JSON.stringify({ id: 11, type: 'reload-view', viewIdx: 2 }))

  await streamwall.waitFor((m) => m.type === 'reload-view' && m.viewIdx === 2)

  const reloads = streamwall.messages.filter(isCommandType('reload-view'))
  assert.equal(reloads.length, 1, 'only the valid command should be forwarded')
  assert.equal(reloads[0].viewIdx, 2)
})

test('does not forward an unknown command type to the Streamwall uplink', async () => {
  const { clientWs, streamwall } = await connectStreamwallAndClient()

  // An admin passes every roleCan check, so only schema validation can stop
  // an unrecognized command from reaching the desktop.
  clientWs.send(JSON.stringify({ id: 20, type: 'evil-command', payload: 1 }))
  clientWs.send(JSON.stringify({ id: 21, type: 'reload-view', viewIdx: 1 }))

  await streamwall.waitFor((m) => m.type === 'reload-view' && m.viewIdx === 1)

  assert.ok(
    // Not a real ControlCommand type: cast, since it can never actually match.
    !streamwall.messages.some((m) => (m.type as string) === 'evil-command'),
    'the unknown command must never be forwarded',
  )
})

test('answers an invalid command with an error response', async () => {
  const { clientWs, client } = await connectStreamwallAndClient()

  clientWs.send(JSON.stringify({ id: 42, type: 'reload-view', viewIdx: -5 }))

  const response = await client.waitFor(isResponseTo(42))
  assert.equal(response.error, 'invalid message')
})

test('rejects a state message with no payload instead of wiring a broken connection', async () => {
  // The old code built a StateWrapper around `undefined`, establishing a
  // connection that crashed clients on view(). Validation must reject it so
  // the connection is never established and the client is told cleanly.
  const { client } = await connectStreamwallAndClient({
    stateMessage: { type: 'state' },
  })

  const response = await client.waitFor(isBareError)
  assert.equal(response.error, 'streamwall disconnected')
})

/** Polls `predicate` until it holds, or rejects after `timeoutMs`. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for condition')
    }
    await delay(20)
  }
}

test('rejects a shape-violating doc update and closes the client to resync', async () => {
  const { clientWs, streamwallWs } = await connectStreamwallAndClient()

  // Replay the binary Yjs frames the uplink receives into a local doc so we
  // can inspect exactly what was broadcast to the desktop.
  const uplinkDoc = new Y.Doc()
  streamwallWs.on('message', (data, isBinary) => {
    if (!isBinary) {
      return
    }
    try {
      Y.applyUpdate(uplinkDoc, new Uint8Array(data as Buffer))
    } catch {
      // ignore malformed frames
    }
  })

  const closed = once(clientWs, 'close', { signal: AbortSignal.timeout(3000) })

  // Malicious: introduces an unexpected top-level container.
  const evil = new Y.Doc()
  evil.getMap('evil').set('x', 'y')
  clientWs.send(Y.encodeStateAsUpdate(evil))

  // The client applied the edit locally; the server rejects it, so it must be
  // closed (like a rate-limit violation) to force a clean resync rather than
  // leaving the operator UI showing an assignment the shared doc never got.
  const [code] = await closed
  assert.equal(code, 1008, 'the client is closed to force a resync')
  assert.equal(
    uplinkDoc.share.has('evil'),
    false,
    'a shape-violating update must never be broadcast to the uplink',
  )
})

test('applies a Streamwall uplink doc update regardless of the per-update size cap', async () => {
  // The desktop uplink is the trusted authority for the shared doc: it sends
  // the full state snapshot on connect, which can exceed the cap meant for
  // untrusted clients. Uplink updates must not be dropped by that cap.
  const { streamwallWs, clientWs } = await connectStreamwallAndClient({
    wsUpdateMaxBytes: 10,
  })

  const clientDoc = new Y.Doc()
  clientWs.on('message', (data, isBinary) => {
    if (!isBinary) {
      return
    }
    try {
      Y.applyUpdate(clientDoc, new Uint8Array(data as Buffer))
    } catch {
      // ignore malformed frames
    }
  })

  const update = new Y.Doc()
  const cell = new Y.Map<string>()
  cell.set('streamId', 'fromuplink')
  update.getMap('views').set('0', cell)
  streamwallWs.send(Y.encodeStateAsUpdate(update))

  await waitUntil(
    () =>
      clientDoc.getMap<Y.Map<string>>('views').get('0')?.get('streamId') ===
      'fromuplink',
  )
})
