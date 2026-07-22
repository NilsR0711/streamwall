import { Low, Memory } from 'lowdb'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { after } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type {
  ClientCommandResponse,
  ClientErrorMessage,
  ClientStateDeltaMessage,
  ClientStateMessage,
  ControlCommandMessage,
  ServerToClientMessage,
  StreamwallRole,
} from 'streamwall-shared'
import WebSocket from 'ws'
import type { ScryptParams } from './auth.ts'
import type { RateLimitConfig } from './config.ts'
import { type AppOptions, initApp } from './index.ts'
import type { LogLevel } from './logger.ts'
import type { SentryCaptureClient } from './sentry.ts'
import type { DocUpdateLimits } from './stateDocGuard.ts'
import type { StorageDB, StoredData } from './storage.ts'
import type { UpdateChecker } from './updateCheck.ts'

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
 * Collects the server's structured log output as parsed JSON entries, so specs
 * can assert on what was logged (and on what was deliberately *not* logged)
 * instead of spying on `console`.
 */
export interface LogCapture {
  entries: Record<string, unknown>[]
  stream: { write(line: string): void }
  /** True when any captured entry's message contains `substring`. */
  hasMessage(substring: string): boolean
  /**
   * Resolves with the first entry matching `predicate`, waiting for one to be
   * logged if none has been yet. Already-captured entries satisfy it, so there
   * is no race between the server logging and the test awaiting. Rejects after
   * `timeoutMs` rather than hanging until the runner's timeout.
   */
  waitFor(
    predicate: (entry: Record<string, unknown>) => boolean,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>
  /** `waitFor` for the common case of matching a substring of the message. */
  waitForMessage(
    substring: string,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>
}

export function captureLogs(): LogCapture {
  type Entry = Record<string, unknown>
  const entries: Entry[] = []
  const waiters: {
    predicate: (entry: Entry) => boolean
    resolve: (entry: Entry) => void
  }[] = []

  function waitFor(
    predicate: (entry: Entry) => boolean,
    timeoutMs = 2000,
  ): Promise<Entry> {
    const existing = entries.find(predicate)
    if (existing !== undefined) {
      return Promise.resolve(existing)
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timed out waiting for matching log entry')),
        timeoutMs,
      )
      waiters.push({
        predicate,
        resolve: (entry) => {
          clearTimeout(timer)
          resolve(entry)
        },
      })
    })
  }

  const messageMatches = (substring: string) => (entry: Entry) =>
    typeof entry.msg === 'string' && entry.msg.includes(substring)

  return {
    entries,
    stream: {
      write(line: string) {
        let entry: Entry
        try {
          entry = JSON.parse(line)
        } catch {
          // Non-JSON output cannot be asserted on; ignore it.
          return
        }
        entries.push(entry)
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i].predicate(entry)) {
            waiters[i].resolve(entry)
            waiters.splice(i, 1)
          }
        }
      },
    },
    hasMessage(substring: string) {
      return entries.some(messageMatches(substring))
    },
    waitFor,
    waitForMessage(substring: string, timeoutMs?: number) {
      return waitFor(messageMatches(substring), timeoutMs)
    },
  }
}

/** One entry a unit under test wrote through an injected structured logger. */
export interface RecordedLogEntry {
  level: 'info' | 'warn'
  fields: Record<string, unknown>
  msg: string | undefined
}

/**
 * A stand-in for the structured logger, recording what a unit under test would
 * have written. For units that take a logger by injection rather than reaching
 * for `console` (see `captureLogs` for asserting on a live server's output).
 */
export function recordingLogger() {
  const entries: RecordedLogEntry[] = []
  const record =
    (level: RecordedLogEntry['level']) =>
    (fields: unknown, msg?: string): void => {
      entries.push({
        level,
        fields: (fields ?? {}) as Record<string, unknown>,
        msg,
      })
    }
  return {
    entries,
    log: { info: record('info'), warn: record('warn') },
  }
}

/**
 * Sets process-wide environment variables for the duration of the current test
 * and restores the previous values afterwards (`undefined` unsets a variable).
 * Reach for it only where the behaviour under test genuinely reads
 * `process.env`; anything `initApp` accepts by injection — the rate limits
 * included — should be passed to `buildTestApp` instead, so the variables never
 * become test API.
 */
export function setEnvForTest(vars: Record<string, string | undefined>): void {
  const previous = Object.entries(vars).map(
    ([key]) => [key, process.env[key]] as const,
  )
  const apply = (
    entries: readonly (readonly [string, string | undefined])[],
  ) => {
    for (const [key, value] of entries) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
  apply(Object.entries(vars))
  after(() => apply(previous))
}

/**
 * Rate limits wide enough to stay out of the way of suites that are not about
 * throttling: a live-server spec opens sockets and redeems invites in a tight
 * loop and would otherwise trip the production budget.
 */
export const WIDE_RATE_LIMITS: Partial<RateLimitConfig> = {
  globalMax: 10000,
  authMax: 10000,
}

/**
 * A deliberately cheap scrypt work factor for tests. Suites that boot a live
 * server pay roughly four derivations per test (mint and verify an uplink
 * token, mint and redeem an invite) that have nothing to do with what is under
 * test; at the production factor that is ~200ms of pure overhead per test.
 * `DEFAULT_SCRYPT_PARAMS` stays in force everywhere it is not injected.
 */
export const TEST_SCRYPT_PARAMS: ScryptParams = { N: 16, r: 8, p: 1 }

/**
 * The origin a test app is built for. Client sockets must present it as their
 * `Origin` header, so specs and helpers have to agree on a single value.
 */
export const TEST_BASE_URL = 'http://localhost:3000'

/** Everything a test may override when building an app instance. */
export type TestAppOverrides = Partial<AppOptions> & {
  db?: StorageDB
  docUpdateLimits?: Partial<DocUpdateLimits>
  logs?: LogCapture
  logLevel?: LogLevel
  rateLimit?: Partial<RateLimitConfig>
  scryptParams?: ScryptParams
  sentryEnabled?: boolean
  sentryClient?: SentryCaptureClient
  updateChecker?: UpdateChecker
}

/**
 * Builds a fully-wired app instance backed by in-memory storage and throwaway
 * static assets, ready for `app.inject()` or `app.listen()` in tests.
 *
 * Logging is silent unless a `logs` capture is passed, in which case every
 * entry down to `trace` is recorded (override with `logLevel`).
 */
export function buildTestApp(overrides: TestAppOverrides = {}) {
  const { logs, logLevel, ...rest } = overrides
  return initApp({
    baseURL: TEST_BASE_URL,
    clientStaticPath: makeStaticDir(),
    db: inMemoryDb(),
    logLevel: logLevel ?? (logs ? 'trace' : 'silent'),
    scryptParams: TEST_SCRYPT_PARAMS,
    ...(logs && { logStream: logs.stream }),
    ...rest,
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

/**
 * Boots a live server on a random port with rate limits wide enough to stay out
 * of the way, captures its structured log output, and closes it after the test.
 *
 * The returned `connectClient` redeems a freshly-minted invite for the given
 * role and opens an authenticated `/client/ws` socket against this server.
 */
export async function startTestServer(overrides: TestAppOverrides = {}) {
  const logs = captureLogs()
  const { app, auth } = await buildTestApp({
    baseURL: TEST_BASE_URL,
    logs,
    rateLimit: WIDE_RATE_LIMITS,
    ...overrides,
  })
  after(() => app.close())
  const port = await listenTestApp(app)

  async function connectClient(role: StreamwallRole = 'admin') {
    const { ws: clientWs, client } = await redeemInviteAndConnectClient(
      app,
      auth,
      port,
      TEST_BASE_URL,
      role,
    )
    return { clientWs, client }
  }

  return { app, auth, port, logs, connectClient }
}

/**
 * `startTestServer` plus a connected Streamwall uplink seeded with a state
 * message (`VALID_STATE` unless overridden).
 *
 * Waits for the server to have finished with the seeded state instead of
 * sleeping: it either accepts it (the uplink becomes the state authority) or
 * rejects it with a structured warning. Both outcomes end the seeding step, and
 * specs deliberately exercise each of them.
 */
export async function bootServerWithUplink({
  stateMessage = { type: 'state', state: VALID_STATE } as Record<
    string,
    unknown
  >,
  ...overrides
}: TestAppOverrides & {
  stateMessage?: Record<string, unknown>
} = {}) {
  const server = await startTestServer(overrides)

  const { ws: streamwallWs, streamwall } = await connectStreamwallUplink(
    server.auth,
    server.port,
  )
  streamwallWs.send(JSON.stringify(stateMessage))
  await server.logs.waitFor(
    (entry) =>
      entry.msg === 'Streamwall connected' ||
      (typeof entry.msg === 'string' &&
        entry.msg.startsWith('Rejected invalid Streamwall state')),
  )

  return { ...server, streamwallWs, streamwall }
}

/** Narrows to the server's reply to the client command with the given `id`. */
export function isResponseTo(id: number) {
  return (m: ServerToClientMessage): m is ClientCommandResponse =>
    'response' in m && m.response === true && m.id === id
}

/** Narrows to a forwarded control command of the given `type`. */
export function isCommandType<Type extends ControlCommandMessage['type']>(
  type: Type,
) {
  return (
    m: ControlCommandMessage,
  ): m is Extract<ControlCommandMessage, { type: Type }> => m.type === type
}

/** Narrows to a bare connection-level rejection (never has `response`). */
export const isBareError = (
  m: ServerToClientMessage,
): m is ClientErrorMessage => !('response' in m) && 'error' in m

/** Narrows to a full state broadcast. */
export const isStateMessage = (
  m: ServerToClientMessage,
): m is ClientStateMessage => 'type' in m && m.type === 'state'

/** Narrows to an incremental state update. */
export const isStateDelta = (
  m: ServerToClientMessage,
): m is ClientStateDeltaMessage => 'type' in m && m.type === 'state-delta'
