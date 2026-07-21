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

/** Temporarily replaces `console.warn`, capturing every call made while active. */
function spyOnConsoleWarn() {
  const calls: unknown[][] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    calls.push(args)
  }
  return {
    calls,
    restore: () => {
      console.warn = original
    },
  }
}

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

  // Invalid: viewId is negative (outside the bounded range).
  clientWs.send(JSON.stringify({ id: 10, type: 'reload-view', viewId: -5 }))
  // Valid: a well-formed command that must reach the uplink.
  clientWs.send(JSON.stringify({ id: 11, type: 'reload-view', viewId: 2 }))

  await streamwall.waitFor((m) => m.type === 'reload-view' && m.viewId === 2)

  const reloads = streamwall.messages.filter(isCommandType('reload-view'))
  assert.equal(reloads.length, 1, 'only the valid command should be forwarded')
  assert.equal(reloads[0].viewId, 2)
})

test('does not forward an unknown command type to the Streamwall uplink', async () => {
  const { clientWs, streamwall } = await connectStreamwallAndClient()

  // An admin passes every roleCan check, so only schema validation can stop
  // an unrecognized command from reaching the desktop.
  clientWs.send(JSON.stringify({ id: 20, type: 'evil-command', payload: 1 }))
  clientWs.send(JSON.stringify({ id: 21, type: 'reload-view', viewId: 1 }))

  await streamwall.waitFor((m) => m.type === 'reload-view' && m.viewId === 1)

  assert.ok(
    // Not a real ControlCommand type: cast, since it can never actually match.
    !streamwall.messages.some((m) => (m.type as string) === 'evil-command'),
    'the unknown command must never be forwarded',
  )
})

test('answers an invalid command with an error response', async () => {
  const { clientWs, client } = await connectStreamwallAndClient()

  clientWs.send(JSON.stringify({ id: 42, type: 'reload-view', viewId: -5 }))

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

test('rejects an initial state payload missing a required field (issue #387)', async () => {
  // The envelope schema only checks "an object" -- an object missing
  // `streams` (or any other required StreamwallState field) must still be
  // rejected by the full streamwallStateSchema check before a StateWrapper is
  // ever built, exactly like a payload with no `state` key at all.
  const { streams: _streams, ...withoutStreams } = VALID_STATE
  const warn = spyOnConsoleWarn()

  try {
    const { client } = await connectStreamwallAndClient({
      stateMessage: { type: 'state', state: withoutStreams },
    })

    const response = await client.waitFor(isBareError)
    assert.equal(response.error, 'streamwall disconnected')
    assert.ok(
      warn.calls.some((args) =>
        String(args[0]).includes('Rejected invalid Streamwall state payload'),
      ),
      'a structured warning must be logged for the rejected payload',
    )
  } finally {
    warn.restore()
  }
})

test('rejects an initial state payload with a malformed view state machine snapshot (issue #387)', async () => {
  const malformed = {
    ...VALID_STATE,
    views: [
      {
        state: { displaying: { running: { playback: 'exploded' } } },
        context: {
          id: 0,
          content: null,
          info: null,
          pos: null,
          error: null,
          volume: 1,
        },
      },
    ],
  }

  const { client } = await connectStreamwallAndClient({
    stateMessage: { type: 'state', state: malformed },
  })

  const response = await client.waitFor(isBareError)
  assert.equal(response.error, 'streamwall disconnected')
})

test('accepts an initial state payload with legitimately empty views', async () => {
  // Regression guard: an empty `views` array is a normal, valid snapshot (a
  // freshly-started desktop with no grid populated yet) and must not be
  // rejected by the stricter validation.
  const { clientWs, streamwall } = await connectStreamwallAndClient()

  clientWs.send(JSON.stringify({ id: 1, type: 'reload-view', viewId: 0 }))
  await streamwall.waitFor((m) => m.type === 'reload-view')

  assert.ok(
    streamwall.messages.some((m) => m.type === 'reload-view'),
    'the connection must be fully established for a valid, empty-views state',
  )
})

test('drops a malformed state update on an already-connected uplink without crashing the session (issue #387)', async () => {
  const { streamwallWs, clientWs, streamwall } =
    await connectStreamwallAndClient()

  const warn = spyOnConsoleWarn()
  try {
    // Malicious/buggy follow-up update: `streams` is not an array at all.
    streamwallWs.send(
      JSON.stringify({ type: 'state', state: { ...VALID_STATE, streams: {} } }),
    )
    await delay(150)

    assert.ok(
      warn.calls.some((args) =>
        String(args[0]).includes('Rejected invalid Streamwall state payload'),
      ),
      'the malformed update must be rejected with a structured warning',
    )
  } finally {
    warn.restore()
  }

  // The session must still be alive and functional: a subsequent valid
  // command from the client is still forwarded to the (still-connected)
  // uplink, proving the malformed update was cleanly dropped rather than
  // tearing down or corrupting the connection.
  clientWs.send(JSON.stringify({ id: 99, type: 'reload-view', viewId: 1 }))
  await streamwall.waitFor((m) => m.type === 'reload-view' && m.viewId === 1)

  assert.ok(
    streamwall.messages.some((m) => m.type === 'reload-view' && m.viewId === 1),
  )
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
