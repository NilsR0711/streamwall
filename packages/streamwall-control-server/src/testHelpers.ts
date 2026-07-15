import { Low, Memory } from 'lowdb'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type {
  ControlCommandMessage,
  ServerToClientMessage,
  StreamwallRole,
} from 'streamwall-shared'
import WebSocket from 'ws'
import { type AppOptions, initApp } from './index.ts'
import type { SentryCaptureClient } from './sentry.ts'
import type { StorageDB, StoredData } from './storage.ts'

/**
 * Creates a throwaway directory containing a minimal index.html so that
 * `@fastify/static` can be registered against a valid root during tests.
 */
export function makeStaticDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sw-static-'))
  writeFileSync(
    path.join(dir, 'index.html'),
    '<!doctype html><title>streamwall test</title>',
  )
  return dir
}

/** An isolated in-memory storage backend, so tests never touch the disk. */
export function inMemoryDb(): Low<StoredData> {
  return new Low<StoredData>(new Memory<StoredData>(), {
    auth: { salt: null, tokens: [] },
    streamwallToken: null,
  })
}

/**
 * Builds a fully-wired app instance backed by in-memory storage and throwaway
 * static assets, ready for `app.inject()` or `app.listen()` in tests.
 */
export function buildTestApp(
  overrides: Partial<AppOptions> & {
    db?: StorageDB
    sentryEnabled?: boolean
    sentryClient?: SentryCaptureClient
  } = {},
) {
  return initApp({
    baseURL: 'http://localhost:3000',
    clientStaticPath: makeStaticDir(),
    db: inMemoryDb(),
    ...overrides,
  })
}

type TestApp = Awaited<ReturnType<typeof buildTestApp>>

/** A minimal valid state doc, accepted as-is by every role's view(). */
export const VALID_STATE = {
  identity: { role: 'admin' },
  config: {
    cols: 3,
    rows: 3,
    width: 1920,
    height: 1080,
    frameless: false,
    fullscreen: false,
    activeColor: '#fff',
    backgroundColor: '#000',
  },
  auth: { invites: [], sessions: [] },
  streams: [],
  customStreams: [],
  views: [],
  fullscreenViewIdx: null,
  streamdelay: null,
  layoutPresets: [],
  favorites: [],
  dataSourceHealth: [],
}

/**
 * Starts `app` listening on a random localhost port and returns that port.
 * Does not register any cleanup — callers decide whether/when to close `app`.
 */
export async function listenTestApp(app: TestApp['app']): Promise<number> {
  await app.listen({ port: 0, host: '127.0.0.1' })
  return (app.server.address() as AddressInfo).port
}

/**
 * Buffers every JSON (text) frame from a socket and lets a test await one
 * matching a predicate. Already-received frames satisfy `waitFor`, so there is
 * no race between attaching a listener and a frame arriving. Binary Yjs frames
 * are ignored.
 */
export function recordJsonMessages<T = unknown>(ws: WebSocket) {
  const messages: T[] = []
  const waiters: {
    predicate: (m: T) => boolean
    resolve: (m: T) => void
  }[] = []

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      return
    }
    let msg: T
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

  /**
   * Overloaded so callers that pass a type-predicate (`(m): m is Foo => ...`)
   * get back a `Promise<Foo>` instead of the wider `Promise<T>`.
   */
  function waitFor<S extends T>(
    predicate: (m: T) => m is S,
    timeoutMs?: number,
  ): Promise<S>
  function waitFor(predicate: (m: T) => boolean, timeoutMs?: number): Promise<T>
  function waitFor(predicate: (m: T) => boolean, timeoutMs = 2000): Promise<T> {
    const existing = messages.find(predicate)
    if (existing !== undefined) {
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
  }

  return { messages, waitFor }
}

/**
 * Captures the first app-level message from the moment the socket is created,
 * so an error the server sends immediately on connect is never missed to a
 * listener-attachment race. `next(timeoutMs)` resolves with that message or
 * null if none arrives within the window.
 */
export function messageCollector(ws: WebSocket) {
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

/**
 * Mints a Streamwall uplink token against `auth` and returns the WebSocket
 * URL and bearer secret needed to connect it, without connecting yet.
 */
export async function mintUplinkToken(auth: TestApp['auth'], port: number) {
  const { tokenId, secret } = await auth.createToken({
    kind: 'streamwall',
    role: 'admin',
    name: 'uplink',
  })
  const base = `ws://127.0.0.1:${port}/streamwall/${tokenId}/ws`
  return { tokenId, secret, base }
}

/**
 * Connects an authenticated Streamwall uplink WebSocket, records its JSON
 * frames from the moment it opens, and terminates it after the test.
 *
 * `T` describes the shape of the JSON frames the caller expects to record,
 * defaulting to the real shape the server forwards over this connection.
 */
export async function connectStreamwallUplink<T = ControlCommandMessage>(
  auth: TestApp['auth'],
  port: number,
) {
  const { base, secret } = await mintUplinkToken(auth, port)
  const ws = new WebSocket(base, {
    headers: { authorization: `Bearer ${secret}` },
  })
  const streamwall = recordJsonMessages<T>(ws)
  after(() => ws.terminate())
  await once(ws, 'open')
  return { ws, streamwall }
}

/**
 * Redeems a freshly-minted invite for `role` and opens an authenticated
 * `/client/ws` socket, recording its JSON frames from the moment it opens.
 *
 * `T` describes the shape of the JSON frames the caller expects to record,
 * defaulting to the real shape the server sends over this connection.
 */
export async function redeemInviteAndConnectClient<T = ServerToClientMessage>(
  app: TestApp['app'],
  auth: TestApp['auth'],
  port: number,
  baseURL: string,
  role: StreamwallRole = 'admin',
) {
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

  const ws = new WebSocket(`ws://127.0.0.1:${port}/client/ws`, {
    headers: { Cookie: cookie, Origin: baseURL },
  })
  const client = recordJsonMessages<T>(ws)
  after(() => ws.terminate())
  await once(ws, 'open')
  return { ws, client }
}
