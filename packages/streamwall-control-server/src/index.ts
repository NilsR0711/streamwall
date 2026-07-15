import fastifyCookie from '@fastify/cookie'
import fastifyHelmet from '@fastify/helmet'
import fastifyRateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import fastifyWebsocket from '@fastify/websocket'
import * as Sentry from '@sentry/node'
import Fastify from 'fastify'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import WebSocket from 'ws'
import * as Y from 'yjs'

import path from 'node:path'
import {
  type AuthTokenInfo,
  controlCommandMessageSchema,
  controlStateMessageSchema,
  inviteLink,
  roleCan,
  stateDiff,
  type StreamwallRole,
  type StreamwallState,
} from 'streamwall-shared'
import { Auth, StateWrapper, uniqueRand62 } from './auth.ts'
import { TokenBucket } from './rateLimiter.ts'
import {
  captureException,
  initSentry,
  type SentryCaptureClient,
} from './sentry.ts'
import {
  applyValidatedDocUpdate,
  type DocUpdateLimits,
} from './stateDocGuard.ts'
import { loadStorage, type StorageDB } from './storage.ts'

export const SESSION_COOKIE_NAME = 's'
// `@fastify/cookie` serializes `maxAge` into the RFC 6265 `Max-Age` attribute,
// which is measured in SECONDS (not milliseconds). Keep this value in seconds —
// one year — so sessions stay long-lived while remaining bounded.
export const SESSION_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60
const STREAMWALL_PING_TIMEOUT_MS = 5 * 1000

const DEFAULT_GLOBAL_RATE_LIMIT_MAX = 100
const DEFAULT_AUTH_RATE_LIMIT_MAX = 10
const DEFAULT_RATE_LIMIT_WINDOW = '1 minute'

// Inbound WebSocket message limits, applied per connection as a token bucket.
// Defaults are generous: normal collaborative editing bursts (e.g. dragging a
// tile) stay well under them, while a flood empties the bucket and the socket
// is closed so the client reconnects and cleanly resyncs.
const DEFAULT_WS_MSG_RATE = 100
const DEFAULT_WS_MSG_BURST = 1000

// Served at `/invite/:id`. It carries no secret and no inline script (so it
// satisfies the strict `script-src 'self'` CSP); the loaded script reads the
// invite secret from the URL fragment and POSTs it to redeem the invite.
const INVITE_EXCHANGE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Streamwall — joining…</title>
  </head>
  <body>
    <p>Signing you in…</p>
    <script src="/invite-exchange.js"></script>
  </body>
</html>
`

// Reads the invite secret from `location.hash` (which the browser never sends
// to the server), scrubs it from the address bar, and exchanges it for a
// session cookie via POST. On success it navigates to the app.
const INVITE_EXCHANGE_SCRIPT = `(function () {
  var status = document.querySelector('p')
  var token = new URLSearchParams(window.location.hash.slice(1)).get('token')
  window.history.replaceState(null, '', window.location.pathname)
  if (!token) {
    if (status) status.textContent = 'This invite link is missing its token.'
    return
  }
  fetch(window.location.pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: token }),
  })
    .then(function (res) {
      if (res.ok) {
        window.location.replace('/')
      } else if (status) {
        status.textContent = 'This invite is invalid or has expired.'
      }
    })
    .catch(function () {
      if (status) {
        status.textContent = 'Could not reach the server. Please try again.'
      }
    })
})()
`

// Bounds on inbound binary Yjs updates from untrusted clients. The shared state
// doc only holds a grid of view assignments, so these are generous headroom
// rather than tight fits — enough to block a single oversized update, or one
// that balloons the doc, from corrupting shared state or exhausting memory.
const DEFAULT_WS_UPDATE_MAX_BYTES = 512 * 1024
const DEFAULT_WS_DOC_GROWTH_MAX_BYTES = 1024 * 1024

/** Parses a positive numeric env value, falling back when unset or invalid. */
function parsePositiveNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * Extracts a Bearer token from an `Authorization` header. Uplink credentials
 * travel in this header rather than the URL query string so the secret never
 * lands in server or proxy access logs. The scheme name is matched
 * case-insensitively per RFC 7235.
 */
function bearerToken(authorization: string | undefined): string | null {
  if (!authorization) {
    return null
  }
  const match = /^Bearer[ ]+(.+)$/i.exec(authorization)
  return match ? match[1] : null
}

interface RateLimitConfig {
  globalMax: number
  authMax: number
  timeWindow: string
}

/**
 * Reads the per-IP rate limit configuration from the environment. Read lazily
 * (per `initApp` call) rather than at module load so overrides apply cleanly.
 */
function getRateLimitConfig(): RateLimitConfig {
  return {
    globalMax: parsePositiveNumber(
      process.env.STREAMWALL_RATE_LIMIT_MAX,
      DEFAULT_GLOBAL_RATE_LIMIT_MAX,
    ),
    authMax: parsePositiveNumber(
      process.env.STREAMWALL_AUTH_RATE_LIMIT_MAX,
      DEFAULT_AUTH_RATE_LIMIT_MAX,
    ),
    timeWindow:
      process.env.STREAMWALL_RATE_LIMIT_WINDOW ?? DEFAULT_RATE_LIMIT_WINDOW,
  }
}

/**
 * Parse `STREAMWALL_TRUST_PROXY` for Fastify's `trustProxy` option.
 * Off by default so a bare internet-facing server never trusts client-supplied
 * `X-Forwarded-For`. Behind a reverse proxy, set `true` (or an IP/CIDR list).
 * @see https://fastify.dev/docs/latest/Reference/Server/#trustproxy
 */
export function parseTrustProxy(
  raw: string | undefined,
): boolean | string {
  if (raw == null || raw.trim() === '') {
    return false
  }
  const v = raw.trim().toLowerCase()
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') {
    return true
  }
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') {
    return false
  }
  // IP, CIDR, or comma-separated list — pass through for Fastify.
  return raw.trim()
}

interface WsMessageLimitConfig {
  capacity: number
  refillPerSec: number
}

/** Reads the inbound WebSocket message rate configuration from the env. */
function getWsMessageLimitConfig(): WsMessageLimitConfig {
  return {
    capacity: parsePositiveNumber(
      process.env.STREAMWALL_WS_MSG_BURST,
      DEFAULT_WS_MSG_BURST,
    ),
    refillPerSec: parsePositiveNumber(
      process.env.STREAMWALL_WS_MSG_RATE,
      DEFAULT_WS_MSG_RATE,
    ),
  }
}

/** Reads the binary Yjs update size limits from the environment. */
function getDocUpdateLimits(): DocUpdateLimits {
  return {
    maxUpdateBytes: parsePositiveNumber(
      process.env.STREAMWALL_WS_UPDATE_MAX_BYTES,
      DEFAULT_WS_UPDATE_MAX_BYTES,
    ),
    maxDocGrowthBytes: parsePositiveNumber(
      process.env.STREAMWALL_WS_DOC_GROWTH_MAX_BYTES,
      DEFAULT_WS_DOC_GROWTH_MAX_BYTES,
    ),
  }
}

/**
 * Wraps a socket with a per-connection inbound message rate limiter. Returns a
 * guard to invoke for each received message: it returns true when the message
 * may be processed, or closes the socket (once) and returns false when the
 * connection has exceeded its message budget.
 */
function createWsMessageGuard(
  ws: WebSocket,
  config: WsMessageLimitConfig,
  label: string,
): () => boolean {
  const bucket = new TokenBucket({
    capacity: config.capacity,
    refillPerSec: config.refillPerSec,
  })
  let closed = false
  return () => {
    if (closed) {
      return false
    }
    if (bucket.tryConsume()) {
      return true
    }
    closed = true
    console.warn(`WebSocket message rate limit exceeded, closing ${label}`)
    try {
      ws.send(JSON.stringify({ error: 'rate limit exceeded' }))
    } catch {
      // The socket is being closed anyway; ignore send failures.
    }
    ws.close(1008, 'rate limit exceeded')
    return false
  }
}

interface Client {
  clientId: string
  ws: WebSocket
  lastStateSent: unknown
  identity: AuthTokenInfo
}

interface StreamwallConnection {
  ws: WebSocket
  clientState: StateWrapper
  stateDoc: Y.Doc
}

export interface AppOptions {
  baseURL: string
  clientStaticPath: string
}

declare module 'fastify' {
  interface FastifyRequest {
    identity?: AuthTokenInfo
  }
}

/**
 * Helper to immediately watch for and queue incoming websocket messages.
 * This is useful for async validation of the connection before handling messages,
 * because awaiting before adding a message event listener can drop messages.
 */
export function queueWebSocketMessages(ws: WebSocket) {
  let queue: WebSocket.Data[] = []
  let messageHandler: ((rawData: WebSocket.Data) => void) | null = null

  const processQueue = () => {
    if (messageHandler !== null) {
      let queuedData
      while ((queuedData = queue.shift())) {
        messageHandler(queuedData)
      }
    }
  }

  const setMessageHandler = (handler: typeof messageHandler) => {
    messageHandler = handler
    processQueue()
  }

  ws.on('message', (rawData) => {
    queue.push(rawData)
    processQueue()
  })

  ws.on('close', () => {
    queue = []
    messageHandler = null
  })

  return setMessageHandler
}

export async function initApp({
  baseURL,
  clientStaticPath,
  db: injectedDb,
  sentryEnabled: injectedSentryEnabled,
  sentryClient,
  trustProxy: injectedTrustProxy,
}: AppOptions & {
  db?: StorageDB
  /** Test-only override so specs can exercise Sentry-enabled paths without a real DSN. */
  sentryEnabled?: boolean
  /** Test-only override for the client `captureException(...)` reports to. */
  sentryClient?: SentryCaptureClient
  /** Test-only override for Fastify trustProxy (else STREAMWALL_TRUST_PROXY / false). */
  trustProxy?: boolean | string
}) {
  const expectedOrigin = new URL(baseURL).origin
  const clients = new Map<string, Client>()
  const isSecure = baseURL.startsWith('https')

  let currentStreamwallWs: WebSocket | null = null
  let currentStreamwallConn: StreamwallConnection | null = null

  const db = injectedDb ?? (await loadStorage())
  const auth = new Auth(db.data.auth)

  const trustProxy =
    injectedTrustProxy ?? parseTrustProxy(process.env.STREAMWALL_TRUST_PROXY)
  const app = Fastify({ trustProxy })

  // Opt-in crash reporting (see sentry.ts for why there is no default DSN).
  // Must be wired up before routes are registered so their errors are covered.
  const sentryEnabled = injectedSentryEnabled ?? initSentry()
  if (sentryEnabled) {
    Sentry.setupFastifyErrorHandler(app)
  }

  // WebSocket message handling and doc-update delivery below run outside
  // Fastify's request lifecycle, so `setupFastifyErrorHandler` never sees
  // their errors — they are caught locally instead. All of those catch sites
  // report here. This includes the ones that wrap a bare `ws.send()`: `ws`
  // does not throw for the routine case of sending to an already-closing
  // socket (it silently buffers via its internal `sendAfterClose` path), so a
  // throw out of `send()` here signals a genuine anomaly (e.g. a payload
  // serialization failure), not ordinary client churn.
  const reportCaughtError = (err: unknown) =>
    captureException(err, sentryEnabled, sentryClient)

  /**
   * Diffs `clientState`'s current view against what each connected client last
   * saw and sends only the delta. Subscribed to `clientState`'s own `'state'`
   * event (see the Streamwall connection handler below) so it also runs for
   * auth-only changes — e.g. `auth.on('state', ...)` calling
   * `clientState.update({ auth: ... })` when an invite/session is
   * created or deleted — not only when the desktop pushes a full state.
   */
  const broadcastStateDeltas = (clientState: StateWrapper) => {
    for (const client of clients.values()) {
      try {
        if (client.ws.readyState !== WebSocket.OPEN) {
          continue
        }
        const stateView = clientState.view(client.identity.role)
        const delta = stateDiff.diff(client.lastStateSent, stateView)
        if (!delta) {
          continue
        }
        client.ws.send(JSON.stringify({ type: 'state-delta', delta }))
        client.lastStateSent = stateView
      } catch (err) {
        console.error('failed to send client state delta', client, err)
        reportCaughtError(err)
      }
    }
  }

  await app.register(fastifyCookie)

  // Security headers. The CSP is kept in sync with the control client, which
  // relies on inline styles and same-origin resources (including the ws:// /
  // wss:// state-sync sockets). `upgrade-insecure-requests` is only emitted
  // when actually served over TLS, otherwise it would rewrite the plain-http
  // WebSocket uplink to wss:// and break it.
  const cspDirectives: Record<string, Iterable<string> | null> = {
    'style-src': ["'self'", "'unsafe-inline'"],
    'connect-src': ["'self'"],
  }
  if (!isSecure) {
    cspDirectives['upgrade-insecure-requests'] = null
  }
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      useDefaults: true,
      directives: cspDirectives,
    },
  })

  // Per-IP rate limiting. Auth-bearing routes run an expensive scrypt
  // derivation per request, so they get a much stricter budget than the
  // global default to blunt scrypt-amplification DoS and credential stuffing.
  const rateLimitConfig = getRateLimitConfig()
  await app.register(fastifyRateLimit, {
    global: true,
    max: rateLimitConfig.globalMax,
    timeWindow: rateLimitConfig.timeWindow,
  })

  const wsMessageLimitConfig = getWsMessageLimitConfig()
  const docUpdateLimits = getDocUpdateLimits()

  await app.register(fastifyWebsocket, {
    errorHandler: (err) => {
      console.warn('Error handling socket request', err)
    },
  })

  // The invite page never receives the secret — it lives in the URL fragment,
  // which the browser does not send — so this bare GET only serves the exchange
  // page and needs no auth rate limit.
  app.get<{ Params: { id: string } }>(
    '/invite/:id',
    async (_request, reply) => {
      return reply.type('text/html').send(INVITE_EXCHANGE_HTML)
    },
  )

  app.get('/invite-exchange.js', async (_request, reply) => {
    return reply
      .type('application/javascript')
      .header('cache-control', 'no-store')
      .send(INVITE_EXCHANGE_SCRIPT)
  })

  // Redeems an invite. The secret arrives in the request body (not the URL),
  // and this route runs the expensive scrypt verification, so it carries the
  // strict auth rate limit.
  app.post<{ Params: { id: string }; Body: { token?: string } }>(
    '/invite/:id',
    {
      config: {
        rateLimit: {
          max: rateLimitConfig.authMax,
          timeWindow: rateLimitConfig.timeWindow,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params
      const token = request.body?.token

      if (!token || typeof token !== 'string') {
        return reply.code(403).send()
      }

      const tokenInfo = await auth.validateToken(id, token)
      if (!tokenInfo || tokenInfo.kind !== 'invite') {
        return reply.code(403).send()
      }

      const sessionToken = await auth.createToken({
        kind: 'session',
        name: tokenInfo.name,
        role: tokenInfo.role,
      })

      reply.setCookie(
        SESSION_COOKIE_NAME,
        `${sessionToken.tokenId}:${sessionToken.secret}`,
        {
          path: '/',
          httpOnly: true,
          secure: isSecure,
          sameSite: 'strict',
          maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
        },
      )

      await auth.deleteToken(tokenInfo.tokenId)
      return reply.code(204).send()
    },
  )

  app.get<{ Params: { id: string } }>(
    '/streamwall/:id/ws',
    { websocket: true },
    async (ws, request) => {
      ws.binaryType = 'arraybuffer'
      const handleMessage = queueWebSocketMessages(ws)

      const { id } = request.params
      const token = bearerToken(request.headers.authorization)

      if (!token) {
        ws.send(JSON.stringify({ error: 'unauthorized' }))
        ws.close()
        return
      }

      const tokenInfo = await auth.validateToken(id, token)
      if (!tokenInfo || tokenInfo.kind !== 'streamwall') {
        ws.send(JSON.stringify({ error: 'unauthorized' }))
        ws.close()
        return
      }

      if (currentStreamwallWs != null) {
        console.warn(
          'Rejecting Streamwall connection (already connected) from',
          request.ip,
          tokenInfo,
        )
        ws.send(JSON.stringify({ error: 'streamwall already connected' }))
        ws.close()
        return
      }

      currentStreamwallWs = ws

      const pingInterval = setInterval(() => {
        ws.ping()
        const pongTimeout = setTimeout(() => {
          if (ws.readyState === ws.OPEN) {
            console.warn(
              `Streamwall timeout: no pong within ${STREAMWALL_PING_TIMEOUT_MS}ms. Closing connection.`,
            )
            ws.terminate()
          }
        }, STREAMWALL_PING_TIMEOUT_MS)
        ws.once('pong', () => {
          clearTimeout(pongTimeout)
        })
      }, STREAMWALL_PING_TIMEOUT_MS)

      ws.on('close', () => {
        console.log('Streamwall disconnected')
        currentStreamwallWs = null
        currentStreamwallConn = null
        clearInterval(pingInterval)

        for (const client of clients.values()) {
          client.ws.close()
        }
      })

      let clientState: StateWrapper | null = null
      const stateDoc = new Y.Doc()

      console.log('Streamwall connecting from', request.ip, tokenInfo)

      const allowMessage = createWsMessageGuard(
        ws,
        wsMessageLimitConfig,
        `streamwall connection from ${request.ip}`,
      )

      handleMessage((rawData) => {
        if (!allowMessage()) {
          return
        }
        if (rawData instanceof ArrayBuffer) {
          // The uplink is the trusted authority for the shared doc and streams
          // the full state snapshot on connect, so it bypasses the size/shape
          // guard applied to untrusted client updates (which would otherwise
          // reject a legitimately large snapshot and silently break sync).
          Y.applyUpdate(stateDoc, new Uint8Array(rawData))
          return
        }

        let raw: unknown
        try {
          raw = JSON.parse(rawData.toString())
        } catch (err) {
          console.warn('Received unexpected ws data: ', rawData.length, 'bytes')
          return
        }

        // The desktop only ever sends `state` messages over this channel.
        // Validate structurally so a malformed payload can never wrap the
        // shared StateWrapper around garbage (which crashed clients on view()).
        const parsed = controlStateMessageSchema.safeParse(raw)
        if (!parsed.success) {
          console.warn(
            'Rejected invalid Streamwall state message:',
            parsed.error.issues[0]?.message,
          )
          return
        }
        const state = parsed.data.state as unknown as StreamwallState

        try {
          if (clientState === null) {
            const newClientState = new StateWrapper(state)
            // Broadcasting on every `'state'` event (rather than only here)
            // is what makes auth-only changes — invite/session created or
            // deleted while the desktop pushes no new state — reach already
            // connected clients; see `auth.on('state', ...)` below.
            newClientState.on('state', () =>
              broadcastStateDeltas(newClientState),
            )
            clientState = newClientState
            clientState.update({ auth: auth.getState() })
            currentStreamwallConn = {
              ws,
              clientState,
              stateDoc,
            }

            console.log('Streamwall connected from', request.ip, tokenInfo)
          } else {
            clientState.update(state)
          }
        } catch (err) {
          console.error('Failed to handle ws message:', rawData, err)
          reportCaughtError(err)
        }
      })

      stateDoc.on('update', (update, origin) => {
        try {
          ws.send(update)
        } catch (err) {
          console.error('Failed to send Streamwall doc update', err)
          reportCaughtError(err)
        }
        for (const client of clients.values()) {
          if (client.clientId === origin) {
            continue
          }
          try {
            client.ws.send(update)
          } catch (err) {
            console.error('Failed to send client doc update:', client, err)
            reportCaughtError(err)
          }
        }
      })
    },
  )

  // Authenticated client routes
  app.register(async function (fastify) {
    fastify.addHook('preHandler', async (request) => {
      const sessionCookie = request.cookies[SESSION_COOKIE_NAME]
      if (sessionCookie) {
        const [tokenId, tokenSecret] = sessionCookie.split(':', 2)
        const tokenInfo = await auth.validateToken(tokenId, tokenSecret)
        if (tokenInfo && tokenInfo.kind === 'session') {
          request.identity = tokenInfo
        }
      }
    })

    // Serve frontend assets
    await fastify.register(fastifyStatic, {
      root: clientStaticPath,
    })

    // Client WebSocket connection
    fastify.get('/client/ws', { websocket: true }, async (ws, request) => {
      ws.binaryType = 'arraybuffer'
      const handleMessage = queueWebSocketMessages(ws)

      const { identity } = request

      if (request.headers.origin !== expectedOrigin || !identity) {
        ws.send(JSON.stringify({ error: 'unauthorized' }))
        ws.close()
        return
      }

      const streamwallConn = currentStreamwallConn
      if (!streamwallConn) {
        ws.send(JSON.stringify({ error: 'streamwall disconnected' }))
        ws.close()
        return
      }

      const clientId = uniqueRand62(8, clients)
      const client: Client = {
        clientId,
        ws,
        lastStateSent: null,
        identity,
      }
      clients.set(clientId, client)

      const pingInterval = setInterval(() => {
        ws.ping()
      }, 20 * 1000)

      ws.on('close', () => {
        clients.delete(clientId)
        clearInterval(pingInterval)

        console.log(
          'Client',
          clientId,
          'disconnected from',
          request.ip,
          client.identity,
        )
      })

      console.log(
        'Client',
        clientId,
        'connected from',
        request.ip,
        client.identity,
      )

      const allowMessage = createWsMessageGuard(
        ws,
        wsMessageLimitConfig,
        `client ${clientId} from ${request.ip}`,
      )

      handleMessage(async (rawData) => {
        if (!allowMessage()) {
          return
        }
        let messageId: number | undefined
        const respond = (responseData: Record<string, unknown>) => {
          if (ws.readyState !== WebSocket.OPEN) {
            return
          }
          ws.send(
            JSON.stringify({
              ...responseData,
              response: true,
              id: messageId,
            }),
          )
        }

        if (!currentStreamwallConn) {
          respond({ error: 'streamwall disconnected' })
          return
        }

        if (rawData instanceof ArrayBuffer) {
          if (!roleCan(identity.role, 'mutate-state-doc')) {
            console.warn(
              `Unauthorized attempt to edit state doc by "${identity.name}"`,
            )
            respond({ error: 'unauthorized' })
            return
          }
          if (
            !applyValidatedDocUpdate(
              streamwallConn.stateDoc,
              new Uint8Array(rawData),
              docUpdateLimits,
              clientId,
            )
          ) {
            // The client already applied this edit to its local doc. Dropping
            // it server-side would leave the operator UI out of sync with the
            // shared doc, so close the socket (like a rate-limit violation) to
            // force a clean reconnect and resync.
            console.warn(
              `Rejected invalid state doc update from client ${clientId}, closing to force resync`,
            )
            ws.close(1008, 'invalid state update')
          }
          return
        }

        let raw: unknown
        try {
          raw = JSON.parse(rawData.toString())
        } catch (err) {
          console.warn('Received unexpected ws data: ', rawData.length, 'bytes')
          return
        }

        // Preserve the client-supplied id (when present) so an error response
        // can still be correlated even if the message is otherwise invalid.
        if (
          typeof raw === 'object' &&
          raw !== null &&
          typeof (raw as { id?: unknown }).id === 'number'
        ) {
          messageId = (raw as { id: number }).id
        }

        // Every command is validated against the shared schema before it is
        // authorized or dispatched: an admin passes every roleCan check, so
        // this is the only barrier stopping a malformed or unknown command
        // from being forwarded to — and executed on — the desktop.
        const parsed = controlCommandMessageSchema.safeParse(raw)
        if (!parsed.success) {
          console.warn(
            `Rejected invalid control message from client ${clientId}:`,
            parsed.error.issues[0]?.message,
          )
          respond({ error: 'invalid message' })
          return
        }
        const msg = parsed.data

        try {
          if (!roleCan(identity.role, msg.type)) {
            console.warn(
              `Unauthorized attempt to "${msg.type}" by "${identity.name}"`,
            )
            respond({ error: 'unauthorized' })
            return
          }

          if (msg.type === 'create-invite') {
            console.debug('Creating invite for role:', msg.role)
            const { tokenId, secret } = await auth.createToken({
              kind: 'invite',
              role: msg.role as StreamwallRole,
              name: msg.name,
            })
            respond({ name: msg.name, secret, tokenId })
          } else if (msg.type === 'delete-token') {
            console.debug('Deleting token:', msg.tokenId)
            auth.deleteToken(msg.tokenId)
          } else {
            streamwallConn.ws.send(
              JSON.stringify({ ...msg, clientId: identity.tokenId }),
            )
          }
        } catch (err) {
          console.error('Failed to handle ws message:', rawData, err)
          reportCaughtError(err)
        }
      })

      const state = streamwallConn.clientState.view(identity.role)
      ws.send(JSON.stringify({ type: 'state', state }))
      ws.send(Y.encodeStateAsUpdate(streamwallConn.stateDoc))
      client.lastStateSent = state
    })
  })

  auth.on('state', (state) => {
    db.update((data) => {
      data.auth = auth.getStoredData()
    })

    const tokenIds = new Set(state.sessions.map((t) => t.tokenId))
    for (const client of clients.values()) {
      if (!tokenIds.has(client.identity.tokenId)) {
        client.ws.close()
      }
    }

    currentStreamwallConn?.clientState.update({ auth: auth.getState() })
  })

  return { app, db, auth }
}

/** Builds the uplink WebSocket endpoint URL, which never embeds the secret. */
function uplinkEndpointURL(baseURL: string, tokenId: string) {
  return `${baseURL.replace(/^http/, 'ws')}/streamwall/${tokenId}/ws`
}

export interface BootstrapResult {
  /**
   * The plaintext uplink secret, exposed *only* when the token was freshly
   * minted. `null` on a restart, where the secret is unrecoverable by design.
   */
  uplinkSecret: string | null
  /** The uplink WebSocket endpoint (never carries the secret). */
  uplinkEndpoint: string
  /** A fresh single-use admin invite link (regenerated every startup). */
  adminInviteLink: string
}

export async function initialInviteCodes({
  db,
  auth,
  baseURL,
}: {
  db: StorageDB
  auth: Auth
  baseURL: string
}): Promise<BootstrapResult> {
  // The uplink token is validated against its scrypt hash in `auth.tokens`,
  // exactly like session and invite tokens. We persist only its id; the
  // plaintext secret is shown once, at creation, and never written to disk.
  const record = db.data.streamwallToken
  const hasValidUplinkToken =
    record != null && auth.tokensById.has(record.tokenId)

  let uplinkSecret: string | null = null
  let uplinkTokenId: string

  if (hasValidUplinkToken) {
    uplinkTokenId = record.tokenId
    // Scrub any plaintext secret a pre-fix server version may have persisted
    // alongside the id, so it stops leaking through storage.json.
    if ((record as { secret?: string }).secret !== undefined) {
      db.update((data) => {
        data.streamwallToken = { tokenId: uplinkTokenId }
      })
    }
  } else {
    // Minting a fresh uplink token (first run, or a rotation triggered by
    // clearing the stored record). Delete any superseded uplink tokens first so
    // an old secret can never authenticate again.
    for (const token of [...auth.tokensById.values()]) {
      if (token.kind === 'streamwall') {
        auth.deleteToken(token.tokenId)
      }
    }
    const minted = await auth.createToken({
      kind: 'streamwall',
      role: 'admin',
      name: 'Streamwall',
    })
    uplinkSecret = minted.secret
    uplinkTokenId = minted.tokenId
    db.update((data) => {
      data.streamwallToken = { tokenId: minted.tokenId }
    })
  }

  // Invalidate any existing admin invites and create a new one:
  for (const adminToken of auth
    .getState()
    .invites.filter(({ role }) => role === 'admin')) {
    auth.deleteToken(adminToken.tokenId)
  }
  const adminToken = await auth.createToken({
    kind: 'invite',
    role: 'admin',
    name: 'Server admin',
  })

  return {
    uplinkSecret,
    uplinkEndpoint: uplinkEndpointURL(baseURL, uplinkTokenId),
    adminInviteLink: inviteLink({
      baseURL,
      tokenId: adminToken.tokenId,
      secret: adminToken.secret,
    }),
  }
}

/**
 * Logs the bootstrap credentials to stdout. The uplink secret is printed only
 * when it was just minted (shown once); on subsequent starts we print the
 * endpoint without it and point the operator at how to rotate.
 */
function logBootstrap({
  uplinkSecret,
  uplinkEndpoint,
  adminInviteLink,
}: BootstrapResult) {
  if (uplinkSecret) {
    console.log(
      '🔌 Streamwall uplink (shown once — save it now):',
      `${uplinkEndpoint}?token=${uplinkSecret}`,
    )
  } else {
    console.log('🔌 Streamwall uplink endpoint:', uplinkEndpoint)
    console.log(
      '   (the uplink secret is shown only at creation; to rotate it, clear ' +
        '"streamwallToken" in storage.json and restart)',
    )
  }
  console.log('🔑 Admin invite:', adminInviteLink)
}

/**
 * Resolve the TCP listen port for the control server.
 * `URL.port` is `""` (not undefined) when the URL has no explicit port, so
 * `??` alone would leave an empty string and `Number('') === 0` (ephemeral bind).
 * Prefer an explicit override, else URL port, else the scheme default.
 */
export function resolveListenPort(
  baseURL: string,
  overridePort?: string,
): number {
  const url = new URL(baseURL)
  const explicit =
    overridePort != null && String(overridePort).trim() !== ''
      ? String(overridePort).trim()
      : undefined
  const fromUrl =
    url.port || (url.protocol === 'https:' ? '443' : '80')
  return Number(explicit ?? fromUrl)
}

export default async function runServer({
  port: overridePort,
  hostname: overrideHostname,
  baseURL,
  clientStaticPath,
}: AppOptions & { hostname?: string; port?: string }) {
  const url = new URL(baseURL)
  const hostname = overrideHostname ?? url.hostname
  const port = resolveListenPort(baseURL, overridePort)

  console.debug('Initializing web server:', { hostname, port })
  const { app, db, auth } = await initApp({
    baseURL,
    clientStaticPath,
  })

  const bootstrap = await initialInviteCodes({ db, auth, baseURL })
  logBootstrap(bootstrap)

  await app.listen({ port, host: hostname })

  return { server: app.server }
}

const isMainModule =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMainModule) {
  runServer({
    hostname: process.env.STREAMWALL_CONTROL_HOSTNAME,
    port: process.env.STREAMWALL_CONTROL_PORT,
    baseURL: process.env.STREAMWALL_CONTROL_URL ?? 'http://localhost:3000',
    clientStaticPath:
      process.env.STREAMWALL_CONTROL_STATIC ??
      path.join(import.meta.dirname, '../../streamwall-control-client/dist'),
  })
}
