import assert from 'node:assert/strict'
import { once } from 'node:events'
import { after, test } from 'node:test'
import WebSocket from 'ws'

import type { Delta } from 'jsondiffpatch'
import {
  stateDiff,
  type ClientCommandResponse,
  type ClientStateDeltaMessage,
  type ClientStateMessage,
  type ControlCommandMessage,
  type ServerToClientMessage,
  type StreamwallRole,
  type StreamwallState,
} from 'streamwall-shared'
import {
  buildTestApp,
  captureLogs,
  connectStreamwallUplink,
  listenTestApp,
  messageCollector,
  mintUplinkToken,
  redeemInviteAndConnectClient,
  VALID_STATE,
  WIDE_RATE_LIMITS,
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

const isStateMessage = (m: ServerToClientMessage): m is ClientStateMessage =>
  'type' in m && m.type === 'state'

const isStateDelta = (m: ServerToClientMessage): m is ClientStateDeltaMessage =>
  'type' in m && m.type === 'state-delta'

/** Applies a `state-delta`'s patch to a client's last-known state, as a real client would. */
function applyDelta(state: StreamwallState, delta: Delta): StreamwallState {
  return stateDiff.patch(structuredClone(state), delta) as StreamwallState
}

/**
 * Boots a live server, connects a Streamwall uplink and seeds it with
 * `VALID_STATE`, and returns a `connectClient` helper that redeems a
 * freshly-minted invite for the given role and opens an authenticated
 * `/client/ws` socket.
 */
async function bootServerWithUplink() {
  const logs = captureLogs()
  const { app, auth } = await buildTestApp({
    baseURL: BASE_URL,
    logs,
    rateLimit: WIDE_RATE_LIMITS,
  })
  after(() => app.close())
  const port = await listenTestApp(app)

  const { ws: streamwallWs, streamwall } = await connectStreamwallUplink(
    auth,
    port,
  )
  streamwallWs.send(JSON.stringify({ type: 'state', state: VALID_STATE }))
  // The uplink is only the state authority once the server has accepted the
  // seeded snapshot; wait for that signal rather than a blind sleep.
  await logs.waitForMessage('Streamwall connected')

  async function connectClient(role: StreamwallRole) {
    const { ws: clientWs, client } = await redeemInviteAndConnectClient(
      app,
      auth,
      port,
      BASE_URL,
      role,
    )
    return { clientWs, client }
  }

  return { app, auth, port, streamwallWs, streamwall, connectClient, logs }
}

test('an operator cannot create-invite: it is dropped, logged, and never forwarded', async () => {
  const { streamwall, connectClient, logs } = await bootServerWithUplink()
  const { clientWs, client } = await connectClient('operator')
  clientWs.send(
    JSON.stringify({
      id: 1,
      type: 'create-invite',
      role: 'admin',
      name: 'x',
    }),
  )
  clientWs.send(JSON.stringify({ id: 2, type: 'reload-view', viewId: 0 }))

  const response = await client.waitFor(isResponseTo(1))
  assert.equal(response.error, 'unauthorized')

  await streamwall.waitFor((m) => m.type === 'reload-view')
  assert.ok(
    !streamwall.messages.some((m) => m.type === 'create-invite'),
    'create-invite must never reach the Streamwall uplink',
  )
  assert.ok(
    logs.hasMessage('Unauthorized attempt to "create-invite"'),
    'the rejection must be logged',
  )
})

test('an operator cannot browse: it is dropped, logged, and never forwarded', async () => {
  const { streamwall, connectClient, logs } = await bootServerWithUplink()
  const { clientWs, client } = await connectClient('operator')
  clientWs.send(
    JSON.stringify({ id: 3, type: 'browse', url: 'https://example.com' }),
  )
  clientWs.send(JSON.stringify({ id: 4, type: 'reload-view', viewId: 0 }))

  const response = await client.waitFor(isResponseTo(3))
  assert.equal(response.error, 'unauthorized')

  await streamwall.waitFor((m) => m.type === 'reload-view')
  assert.ok(
    !streamwall.messages.some((m) => m.type === 'browse'),
    'browse must never reach the Streamwall uplink',
  )
  assert.ok(
    logs.hasMessage('Unauthorized attempt to "browse"'),
    'the rejection must be logged',
  )
})

test('a monitor cannot create-invite: it is dropped, logged, and never forwarded', async () => {
  const { streamwall, connectClient, logs } = await bootServerWithUplink()
  const { clientWs, client } = await connectClient('monitor')
  clientWs.send(
    JSON.stringify({
      id: 5,
      type: 'create-invite',
      role: 'admin',
      name: 'x',
    }),
  )
  clientWs.send(
    JSON.stringify({ id: 6, type: 'set-stream-censored', isCensored: true }),
  )

  const response = await client.waitFor(isResponseTo(5))
  assert.equal(response.error, 'unauthorized')

  await streamwall.waitFor((m) => m.type === 'set-stream-censored')
  assert.ok(
    !streamwall.messages.some((m) => m.type === 'create-invite'),
    'create-invite must never reach the Streamwall uplink',
  )
  assert.ok(
    logs.hasMessage('Unauthorized attempt to "create-invite"'),
    'the rejection must be logged',
  )
})

test('a monitor cannot browse: it is dropped, logged, and never forwarded', async () => {
  const { streamwall, connectClient, logs } = await bootServerWithUplink()
  const { clientWs, client } = await connectClient('monitor')
  clientWs.send(
    JSON.stringify({ id: 7, type: 'browse', url: 'https://example.com' }),
  )
  clientWs.send(
    JSON.stringify({ id: 8, type: 'set-stream-censored', isCensored: true }),
  )

  const response = await client.waitFor(isResponseTo(7))
  assert.equal(response.error, 'unauthorized')

  await streamwall.waitFor((m) => m.type === 'set-stream-censored')
  assert.ok(
    !streamwall.messages.some((m) => m.type === 'browse'),
    'browse must never reach the Streamwall uplink',
  )
  assert.ok(
    logs.hasMessage('Unauthorized attempt to "browse"'),
    'the rejection must be logged',
  )
})

test('an operator can set-listening-view: it is forwarded to the Streamwall uplink', async () => {
  const { streamwall, connectClient } = await bootServerWithUplink()
  const { clientWs } = await connectClient('operator')

  clientWs.send(
    JSON.stringify({ id: 9, type: 'set-listening-view', viewId: 0 }),
  )

  const forwarded = await streamwall.waitFor(
    isCommandType('set-listening-view'),
  )
  assert.equal(forwarded.viewId, 0)
})

test("an admin's state broadcast includes auth while an operator's does not", async () => {
  const { connectClient } = await bootServerWithUplink()
  const { client: adminClient } = await connectClient('admin')
  const { client: operatorClient } = await connectClient('operator')

  const adminState = await adminClient.waitFor(isStateMessage)
  const operatorState = await operatorClient.waitFor(isStateMessage)

  assert.ok(
    adminState.state.auth && Array.isArray(adminState.state.auth.sessions),
    'admin must receive the auth state (invites/sessions)',
  )
  assert.equal(
    operatorState.state.auth,
    undefined,
    'operator must never receive the auth state',
  )
})

/** Boots a live server and mints a Streamwall uplink token, without connecting yet. */
async function startUplinkServer() {
  const logs = captureLogs()
  const { app, auth } = await buildTestApp({
    baseURL: BASE_URL,
    logs,
    rateLimit: WIDE_RATE_LIMITS,
  })
  after(() => app.close())
  const port = await listenTestApp(app)
  const { base, secret } = await mintUplinkToken(auth, port)
  return { app, auth, port, base, secret, logs }
}

test('rejects a second Streamwall connection while the first stays connected', async () => {
  const {
    auth,
    port,
    streamwallWs: first,
    connectClient,
    logs,
  } = await bootServerWithUplink()
  // Registering the first uplink connection requires the server to await a
  // real `validateToken` scrypt derivation, so the client's 'open' event
  // alone is not proof that registration has actually completed — most
  // visible on a loaded/slower CI runner. Round-trip a client through the
  // state broadcast the uplink
  // just sent: that broadcast can only happen after registration finished,
  // so it deterministically proves the race window has closed rather than
  // assuming a fixed ordering.
  const { client } = await connectClient('admin')
  await client.waitFor(isStateMessage)

  const secondToken = await auth.createToken({
    kind: 'streamwall',
    role: 'admin',
    name: 'second uplink',
  })
  const second = new WebSocket(
    `ws://127.0.0.1:${port}/streamwall/${secondToken.tokenId}/ws`,
    { headers: { authorization: `Bearer ${secondToken.secret}` } },
  )
  after(() => second.terminate())
  const nextMessage = messageCollector(second)

  assert.deepEqual(
    await nextMessage(2000),
    { error: 'streamwall already connected' },
    'the second connection must be rejected',
  )

  await once(second, 'close', { signal: AbortSignal.timeout(2000) })

  assert.equal(
    first.readyState,
    WebSocket.OPEN,
    'the first Streamwall connection must remain unaffected',
  )
  assert.ok(
    logs.hasMessage('Rejecting Streamwall connection'),
    'the rejection must be logged',
  )
})

test('a state message sent immediately on connect is not dropped while auth validation is pending', async () => {
  // `auth.validateToken` runs a real (async) scrypt derivation, so there is a
  // genuine window between the socket opening and the server resolving the
  // uplink's identity. `queueWebSocketMessages` exists precisely to buffer
  // messages sent during that window rather than lose them because the real
  // message handler isn't attached yet.
  const { app, auth, port, base, secret } = await startUplinkServer()

  const streamwallWs = new WebSocket(base, {
    headers: { authorization: `Bearer ${secret}` },
  })
  after(() => streamwallWs.terminate())
  await once(streamwallWs, 'open')
  streamwallWs.send(JSON.stringify({ type: 'state', state: VALID_STATE }))

  const { client } = await redeemInviteAndConnectClient(
    app,
    auth,
    port,
    BASE_URL,
  )

  const stateMsg = await client.waitFor(isStateMessage)
  assert.deepEqual(
    stateMsg.state.config,
    VALID_STATE.config,
    'the state message sent immediately on open must have been applied, not dropped',
  )
})

test('creating an invite live-pushes a state-delta to an already-connected admin client', async () => {
  const { auth, connectClient } = await bootServerWithUplink()
  const { client: adminClient } = await connectClient('admin')

  // Consume the initial `state` message so later assertions only see deltas
  // caused by the invite below, not the connect-time snapshot.
  let state = (await adminClient.waitFor(isStateMessage)).state

  await auth.createToken({ kind: 'invite', role: 'operator', name: 'new op' })

  const delta = await adminClient.waitFor(isStateDelta)
  state = applyDelta(state, delta.delta)
  assert.ok(
    state.auth?.invites.some((invite) => invite.name === 'new op'),
    'the new invite must appear via a live delta, without waiting for an unrelated desktop state push',
  )
})

test('deleting a token live-pushes a state-delta to an already-connected admin client', async () => {
  const { auth, connectClient } = await bootServerWithUplink()
  const { client: adminClient } = await connectClient('admin')
  let state = (await adminClient.waitFor(isStateMessage)).state

  const invite = await auth.createToken({
    kind: 'invite',
    role: 'operator',
    name: 'to revoke',
  })
  const createDelta = await adminClient.waitFor(isStateDelta)
  state = applyDelta(state, createDelta.delta)
  assert.ok(state.auth?.invites.some((i) => i.tokenId === invite.tokenId))

  auth.deleteToken(invite.tokenId)

  const deleteDelta = await adminClient.waitFor(
    (m): m is ClientStateDeltaMessage => isStateDelta(m) && m !== createDelta,
  )
  state = applyDelta(state, deleteDelta.delta)
  assert.ok(
    !state.auth?.invites.some((i) => i.tokenId === invite.tokenId),
    'the revoked invite must disappear via a live delta, without waiting for an unrelated desktop state push',
  )
})

test("an admin's delete-token command revokes the token and live-pushes the removal to other connected clients", async () => {
  const { auth, connectClient } = await bootServerWithUplink()
  const { clientWs: actingAdminWs } = await connectClient('admin')
  // A second admin client (only admins are ever sent `auth` state, see
  // `StateWrapper.view`) proves the removal is broadcast, not just reflected
  // back to the client that sent the command.
  const { client: otherAdminClient } = await connectClient('admin')
  let state = (await otherAdminClient.waitFor(isStateMessage)).state

  const invite = await auth.createToken({
    kind: 'invite',
    role: 'operator',
    name: 'to revoke',
  })
  const createDelta = await otherAdminClient.waitFor(isStateDelta)
  state = applyDelta(state, createDelta.delta)
  assert.ok(state.auth?.invites.some((i) => i.tokenId === invite.tokenId))

  actingAdminWs.send(
    JSON.stringify({ id: 20, type: 'delete-token', tokenId: invite.tokenId }),
  )

  const deleteDelta = await otherAdminClient.waitFor(
    (m): m is ClientStateDeltaMessage => isStateDelta(m) && m !== createDelta,
  )
  state = applyDelta(state, deleteDelta.delta)
  assert.ok(
    !state.auth?.invites.some((i) => i.tokenId === invite.tokenId),
    'the revoked invite must disappear via a live delta pushed to another connected client, not just the actor',
  )
  assert.ok(
    !auth.getStoredData().tokens.some((t) => t.tokenId === invite.tokenId),
    'the delete-token command must remove the token from storage',
  )
})

test('an admin revoking their own session via delete-token closes their own socket', async () => {
  const { connectClient } = await bootServerWithUplink()
  const { clientWs: adminWs, client: adminClient } =
    await connectClient('admin')

  const state = (await adminClient.waitFor(isStateMessage)).state
  const ownTokenId = state.auth?.sessions[0]?.tokenId
  assert.ok(
    ownTokenId,
    'the initial state pushed on connect must include the just-redeemed session',
  )

  const closed = once(adminWs, 'close', { signal: AbortSignal.timeout(3000) })
  adminWs.send(
    JSON.stringify({ id: 21, type: 'delete-token', tokenId: ownTokenId }),
  )

  await closed
  assert.equal(adminWs.readyState, WebSocket.CLOSED)
})
