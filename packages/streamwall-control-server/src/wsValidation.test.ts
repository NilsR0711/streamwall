import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { after, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'
import * as Y from 'yjs'
import { buildTestApp } from './testHelpers.ts'

const BASE_URL = 'http://localhost:3000'

// A per-test override of the update cap must not leak into other test files.
after(() => {
  delete process.env.STREAMWALL_WS_UPDATE_MAX_BYTES
})

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
 * Boots a live server, connects a Streamwall uplink and seeds a state message,
 * then redeems an invite and opens an authenticated client socket. JSON frames
 * from both sockets are recorded from the moment they open.
 */
async function connectStreamwallAndClient({
  stateMessage = { type: 'state', state: VALID_STATE } as Record<
    string,
    unknown
  >,
  role = 'admin' as const,
  wsUpdateMaxBytes,
}: {
  stateMessage?: Record<string, unknown>
  role?: 'admin' | 'operator' | 'monitor'
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

  streamwallWs.send(JSON.stringify(stateMessage))
  await delay(150)

  const invite = await auth.createToken({
    kind: 'invite',
    role,
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
  const client = recordJsonMessages(clientWs)
  after(() => clientWs.terminate())
  await once(clientWs, 'open')

  return { app, auth, streamwallWs, clientWs, streamwall, client }
}

test('does not forward an out-of-bounds command to the Streamwall uplink', async () => {
  const { clientWs, streamwall } = await connectStreamwallAndClient()

  // Invalid: viewIdx is negative (outside the bounded range).
  clientWs.send(JSON.stringify({ id: 10, type: 'reload-view', viewIdx: -5 }))
  // Valid: a well-formed command that must reach the uplink.
  clientWs.send(JSON.stringify({ id: 11, type: 'reload-view', viewIdx: 2 }))

  await streamwall.waitFor((m) => m.type === 'reload-view' && m.viewIdx === 2)

  const reloads = streamwall.messages.filter((m) => m.type === 'reload-view')
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
    !streamwall.messages.some((m) => m.type === 'evil-command'),
    'the unknown command must never be forwarded',
  )
})

test('answers an invalid command with an error response', async () => {
  const { clientWs, client } = await connectStreamwallAndClient()

  clientWs.send(JSON.stringify({ id: 42, type: 'reload-view', viewIdx: -5 }))

  const response = await client.waitFor(
    (m) => m.response === true && m.id === 42,
  )
  assert.equal(response.error, 'invalid message')
})

test('rejects a state message with no payload instead of wiring a broken connection', async () => {
  // The old code built a StateWrapper around `undefined`, establishing a
  // connection that crashed clients on view(). Validation must reject it so
  // the connection is never established and the client is told cleanly.
  const { client } = await connectStreamwallAndClient({
    stateMessage: { type: 'state' },
  })

  const response = await client.waitFor((m) => typeof m.error === 'string')
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
