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
}: {
  stateMessage?: Record<string, unknown>
  role?: 'admin' | 'operator' | 'monitor'
} = {}) {
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
