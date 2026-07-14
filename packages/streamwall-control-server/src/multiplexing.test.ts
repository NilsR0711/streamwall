import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { after, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'

import { buildTestApp } from './testHelpers.ts'

const BASE_URL = 'http://localhost:3000'

const VALID_STATE = {
  identity: { role: 'admin' },
  config: {
    cols: 3,
    rows: 3,
    width: 1920,
    height: 1080,
    frameless: false,
    activeColor: '#fff',
    backgroundColor: '#000',
  },
  auth: { invites: [], sessions: [] },
  streams: [],
  customStreams: [],
  views: [],
  streamdelay: null,
}

/**
 * Buffers every JSON (text) frame from a socket and lets a test await one
 * matching a predicate. Already-received frames satisfy `waitFor`, so there is
 * no race between attaching a listener and a frame arriving. Binary Yjs frames
 * are ignored.
 */
function recordJsonMessages(ws: WebSocket) {
  const messages: any[] = []
  const waiters: {
    predicate: (m: any) => boolean
    resolve: (m: any) => void
  }[] = []

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      return
    }
    let msg: any
    try {
      msg = JSON.parse(data.toString())
    } catch {
      return
    }
    messages.push(msg)
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].predicate(msg)) {
        waiters[i].resolve(msg)
        waiters.splice(i, 1)
      }
    }
  })

  return {
    messages,
    waitFor(predicate: (m: any) => boolean, timeoutMs = 2000): Promise<any> {
      const existing = messages.find(predicate)
      if (existing) {
        return Promise.resolve(existing)
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('timed out waiting for matching ws message')),
          timeoutMs,
        )
        waiters.push({
          predicate,
          resolve: (m) => {
            clearTimeout(timer)
            resolve(m)
          },
        })
      })
    },
  }
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
  await app.listen({ port: 0, host: '127.0.0.1' })
  const { port } = app.server.address() as AddressInfo

  const swToken = await auth.createToken({
    kind: 'streamwall',
    role: 'admin',
    name: 'uplink',
  })
  const streamwallWs = new WebSocket(
    `ws://127.0.0.1:${port}/streamwall/${swToken.tokenId}/ws`,
    { headers: { authorization: `Bearer ${swToken.secret}` } },
  )
  const streamwall = recordJsonMessages(streamwallWs)
  after(() => streamwallWs.terminate())
  await once(streamwallWs, 'open')

  streamwallWs.send(JSON.stringify({ type: 'state', state: VALID_STATE }))
  await delay(150)

  async function connectClient(role: 'admin' | 'operator' | 'monitor') {
    const invite = await auth.createToken({
      kind: 'invite',
      role,
      name: `${role} client`,
    })
    const redeem = await app.inject({
      method: 'POST',
      url: `/invite/${invite.tokenId}`,
      headers: { 'content-type': 'application/json' },
      payload: { token: invite.secret },
    })
    const rawCookie = redeem.headers['set-cookie']
    const cookie = (
      Array.isArray(rawCookie) ? rawCookie[0] : String(rawCookie)
    ).split(';')[0]

    const clientWs = new WebSocket(`ws://127.0.0.1:${port}/client/ws`, {
      headers: { Cookie: cookie, Origin: BASE_URL },
    })
    const client = recordJsonMessages(clientWs)
    after(() => clientWs.terminate())
    await once(clientWs, 'open')
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
  await app.listen({ port: 0, host: '127.0.0.1' })
  const { port } = app.server.address() as AddressInfo

  const { tokenId, secret } = await auth.createToken({
    kind: 'streamwall',
    role: 'admin',
    name: 'uplink',
  })
  const base = `ws://127.0.0.1:${port}/streamwall/${tokenId}/ws`
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

  const invite = await auth.createToken({
    kind: 'invite',
    role: 'admin',
    name: 'client',
  })
  const redeem = await app.inject({
    method: 'POST',
    url: `/invite/${invite.tokenId}`,
    headers: { 'content-type': 'application/json' },
    payload: { token: invite.secret },
  })
  const rawCookie = redeem.headers['set-cookie']
  const cookie = (
    Array.isArray(rawCookie) ? rawCookie[0] : String(rawCookie)
  ).split(';')[0]

  const clientWs = new WebSocket(`ws://127.0.0.1:${port}/client/ws`, {
    headers: { Cookie: cookie, Origin: BASE_URL },
  })
  after(() => clientWs.terminate())
  const client = recordJsonMessages(clientWs)
  await once(clientWs, 'open')

  const stateMsg = await client.waitFor((m) => m.type === 'state')
  assert.deepEqual(
    stateMsg.state.config,
    VALID_STATE.config,
    'the state message sent immediately on open must have been applied, not dropped',
  )
})
