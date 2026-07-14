import assert from 'node:assert/strict'
import { once } from 'node:events'
import { after, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'

import type { StreamwallRole } from 'streamwall-shared'
import {
  buildTestApp,
  connectStreamwallUplink,
  listenTestApp,
  messageCollector,
  mintUplinkToken,
  redeemInviteAndConnectClient,
  VALID_STATE,
} from './testHelpers.ts'

const BASE_URL = 'http://localhost:3000'

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

/**
 * Boots a live server, connects a Streamwall uplink and seeds it with
 * `VALID_STATE`, and returns a `connectClient` helper that redeems a
 * freshly-minted invite for the given role and opens an authenticated
 * `/client/ws` socket.
 */
async function bootServerWithUplink() {
  process.env.STREAMWALL_RATE_LIMIT_MAX = '10000'
  process.env.STREAMWALL_AUTH_RATE_LIMIT_MAX = '10000'

  const { app, auth } = await buildTestApp({ baseURL: BASE_URL })
  after(() => app.close())
  const port = await listenTestApp(app)

  const { ws: streamwallWs, streamwall } = await connectStreamwallUplink<any>(
    auth,
    port,
  )
  streamwallWs.send(JSON.stringify({ type: 'state', state: VALID_STATE }))
  await delay(150)

  async function connectClient(role: StreamwallRole) {
    const { ws: clientWs, client } = await redeemInviteAndConnectClient<any>(
      app,
      auth,
      port,
      BASE_URL,
      role,
    )
    return { clientWs, client }
  }

  return { app, auth, port, streamwallWs, streamwall, connectClient }
}

test('an operator cannot create-invite: it is dropped, logged, and never forwarded', async () => {
  const { streamwall, connectClient } = await bootServerWithUplink()
  const { clientWs, client } = await connectClient('operator')
  const warn = spyOnConsoleWarn()

  try {
    clientWs.send(
      JSON.stringify({
        id: 1,
        type: 'create-invite',
        role: 'admin',
        name: 'x',
      }),
    )
    clientWs.send(JSON.stringify({ id: 2, type: 'reload-view', viewIdx: 0 }))

    const response = await client.waitFor(
      (m) => m.response === true && m.id === 1,
    )
    assert.equal(response.error, 'unauthorized')

    await streamwall.waitFor((m) => m.type === 'reload-view')
    assert.ok(
      !streamwall.messages.some((m) => m.type === 'create-invite'),
      'create-invite must never reach the Streamwall uplink',
    )
    assert.ok(
      warn.calls.some((args) =>
        String(args[0]).includes('Unauthorized attempt to "create-invite"'),
      ),
      'the rejection must be logged',
    )
  } finally {
    warn.restore()
  }
})

test('an operator cannot browse: it is dropped, logged, and never forwarded', async () => {
  const { streamwall, connectClient } = await bootServerWithUplink()
  const { clientWs, client } = await connectClient('operator')
  const warn = spyOnConsoleWarn()

  try {
    clientWs.send(
      JSON.stringify({ id: 3, type: 'browse', url: 'https://example.com' }),
    )
    clientWs.send(JSON.stringify({ id: 4, type: 'reload-view', viewIdx: 0 }))

    const response = await client.waitFor(
      (m) => m.response === true && m.id === 3,
    )
    assert.equal(response.error, 'unauthorized')

    await streamwall.waitFor((m) => m.type === 'reload-view')
    assert.ok(
      !streamwall.messages.some((m) => m.type === 'browse'),
      'browse must never reach the Streamwall uplink',
    )
    assert.ok(
      warn.calls.some((args) =>
        String(args[0]).includes('Unauthorized attempt to "browse"'),
      ),
      'the rejection must be logged',
    )
  } finally {
    warn.restore()
  }
})

test('a monitor cannot create-invite: it is dropped, logged, and never forwarded', async () => {
  const { streamwall, connectClient } = await bootServerWithUplink()
  const { clientWs, client } = await connectClient('monitor')
  const warn = spyOnConsoleWarn()

  try {
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

    const response = await client.waitFor(
      (m) => m.response === true && m.id === 5,
    )
    assert.equal(response.error, 'unauthorized')

    await streamwall.waitFor((m) => m.type === 'set-stream-censored')
    assert.ok(
      !streamwall.messages.some((m) => m.type === 'create-invite'),
      'create-invite must never reach the Streamwall uplink',
    )
    assert.ok(
      warn.calls.some((args) =>
        String(args[0]).includes('Unauthorized attempt to "create-invite"'),
      ),
      'the rejection must be logged',
    )
  } finally {
    warn.restore()
  }
})

test('a monitor cannot browse: it is dropped, logged, and never forwarded', async () => {
  const { streamwall, connectClient } = await bootServerWithUplink()
  const { clientWs, client } = await connectClient('monitor')
  const warn = spyOnConsoleWarn()

  try {
    clientWs.send(
      JSON.stringify({ id: 7, type: 'browse', url: 'https://example.com' }),
    )
    clientWs.send(
      JSON.stringify({ id: 8, type: 'set-stream-censored', isCensored: true }),
    )

    const response = await client.waitFor(
      (m) => m.response === true && m.id === 7,
    )
    assert.equal(response.error, 'unauthorized')

    await streamwall.waitFor((m) => m.type === 'set-stream-censored')
    assert.ok(
      !streamwall.messages.some((m) => m.type === 'browse'),
      'browse must never reach the Streamwall uplink',
    )
    assert.ok(
      warn.calls.some((args) =>
        String(args[0]).includes('Unauthorized attempt to "browse"'),
      ),
      'the rejection must be logged',
    )
  } finally {
    warn.restore()
  }
})

test('an operator can set-listening-view: it is forwarded to the Streamwall uplink', async () => {
  const { streamwall, connectClient } = await bootServerWithUplink()
  const { clientWs } = await connectClient('operator')

  clientWs.send(
    JSON.stringify({ id: 9, type: 'set-listening-view', viewIdx: 0 }),
  )

  const forwarded = await streamwall.waitFor(
    (m) => m.type === 'set-listening-view',
  )
  assert.equal(forwarded.viewIdx, 0)
})

test("an admin's state broadcast includes auth while an operator's does not", async () => {
  const { connectClient } = await bootServerWithUplink()
  const { client: adminClient } = await connectClient('admin')
  const { client: operatorClient } = await connectClient('operator')

  const adminState = await adminClient.waitFor((m) => m.type === 'state')
  const operatorState = await operatorClient.waitFor((m) => m.type === 'state')

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
  process.env.STREAMWALL_RATE_LIMIT_MAX = '10000'
  const { app, auth } = await buildTestApp({ baseURL: BASE_URL })
  after(() => app.close())
  const port = await listenTestApp(app)
  const { base, secret } = await mintUplinkToken(auth, port)
  return { app, auth, port, base, secret }
}

test('rejects a second Streamwall connection while the first stays connected', async () => {
  const { base, secret } = await startUplinkServer()
  const warn = spyOnConsoleWarn()

  try {
    const first = new WebSocket(base, {
      headers: { authorization: `Bearer ${secret}` },
    })
    after(() => first.terminate())
    await once(first, 'open')

    const second = new WebSocket(base, {
      headers: { authorization: `Bearer ${secret}` },
    })
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
      warn.calls.some((args) =>
        String(args[0]).includes('Rejecting Streamwall connection'),
      ),
      'the rejection must be logged',
    )
  } finally {
    warn.restore()
  }
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

  const { client } = await redeemInviteAndConnectClient<any>(
    app,
    auth,
    port,
    BASE_URL,
  )

  const stateMsg = await client.waitFor((m) => m.type === 'state')
  assert.deepEqual(
    stateMsg.state.config,
    VALID_STATE.config,
    'the state message sent immediately on open must have been applied, not dropped',
  )
})
