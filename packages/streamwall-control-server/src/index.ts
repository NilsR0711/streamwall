import fastifyCookie from '@fastify/cookie'
import fastifyHelmet from '@fastify/helmet'
import fastifyRateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import fastifyWebsocket from '@fastify/websocket'
import Fastify from 'fastify'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import WebSocket from 'ws'
import * as Y from 'yjs'

import path from 'node:path'
import {
  type AuthTokenInfo,
  type ControlCommandMessage,
  type ControlUpdateMessage,
  inviteLink,
  roleCan,
  stateDiff,
  type StreamwallRole,
} from 'streamwall-shared'
import { Auth, StateWrapper, uniqueRand62 } from './auth.ts'
import { TokenBucket } from './rateLimiter.ts'
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

/** Parses a positive numeric env value, falling back when unset or invalid. */
function parsePositiveNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
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
  lastStateSent: any
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
function queueWebSocketMessages(ws: WebSocket) {
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
}: AppOptions & { db?: StorageDB }) {
  const expectedOrigin = new URL(baseURL).origin
  const clients = new Map<string, Client>()
  const isSecure = baseURL.startsWith('https')

  let currentStreamwallWs: WebSocket | null = null
  let currentStreamwallConn: StreamwallConnection | null = null

  const db = injectedDb ?? (await loadStorage())
  const auth = new Auth(db.data.auth)

  const app = Fastify()

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

  await app.register(fastifyWebsocket, {
    errorHandler: (err) => {
      console.warn('Error handling socket request', err)
    },
  })

  app.get<{ Params: { id: string }; Querystring: { token?: string } }>(
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
      const { token } = request.query

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
      return reply.redirect('/')
    },
  )

  app.get<{ Params: { id: string }; Querystring: { token?: string } }>(
    '/streamwall/:id/ws',
    { websocket: true },
    async (ws, request) => {
      ws.binaryType = 'arraybuffer'
      const handleMessage = queueWebSocketMessages(ws)

      const { id } = request.params
      const { token } = request.query

      if (!token || typeof token !== 'string') {
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
          Y.applyUpdate(stateDoc, new Uint8Array(rawData))
          return
        }

        let msg: ControlUpdateMessage

        try {
          msg = JSON.parse(rawData.toString())
        } catch (err) {
          console.warn('Received unexpected ws data: ', rawData.length, 'bytes')
          return
        }

        try {
          if (msg.type === 'state') {
            if (clientState === null) {
              clientState = new StateWrapper(msg.state)
              clientState.update({ auth: auth.getState() })
              currentStreamwallConn = {
                ws,
                clientState,
                stateDoc,
              }

              console.log('Streamwall connected from', request.ip, tokenInfo)
            } else {
              clientState.update(msg.state)
            }

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
                console.error('failed to send client state delta', client)
              }
            }
          }
        } catch (err) {
          console.error('Failed to handle ws message:', rawData, err)
        }
      })

      stateDoc.on('update', (update, origin) => {
        try {
          ws.send(update)
        } catch (err) {
          console.error('Failed to send Streamwall doc update')
        }
        for (const client of clients.values()) {
          if (client.clientId === origin) {
            continue
          }
          try {
            client.ws.send(update)
          } catch (err) {
            console.error('Failed to send client doc update:', client)
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
        let msg: ControlCommandMessage
        const respond = (responseData: any) => {
          if (ws.readyState !== WebSocket.OPEN) {
            return
          }
          ws.send(
            JSON.stringify({
              ...responseData,
              response: true,
              id: msg && msg.id,
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
          Y.applyUpdate(
            streamwallConn.stateDoc,
            new Uint8Array(rawData),
            clientId,
          )
          return
        }

        try {
          msg = JSON.parse(rawData.toString())
        } catch (err) {
          console.warn('Received unexpected ws data: ', rawData.length, 'bytes')
          return
        }

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

export default async function runServer({
  port: overridePort,
  hostname: overrideHostname,
  baseURL,
  clientStaticPath,
}: AppOptions & { hostname?: string; port?: string }) {
  const url = new URL(baseURL)
  const hostname = overrideHostname ?? url.hostname
  const port = Number(overridePort ?? url.port ?? '80')

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
