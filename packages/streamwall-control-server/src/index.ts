import fastifyCookie from '@fastify/cookie'
import fastifyHelmet from '@fastify/helmet'
import fastifyRateLimit from '@fastify/rate-limit'
import fastifyWebsocket from '@fastify/websocket'
import * as Sentry from '@sentry/node'
import Fastify from 'fastify'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { Auth, type ScryptParams } from './auth.ts'
import runServer from './bootstrap.ts'
import {
  getDocUpdateLimits,
  getRateLimitConfig,
  getWsMessageLimitConfig,
  parseTrustProxy,
} from './config.ts'
import {
  type AppContext,
  type Client,
  createBroadcastStateDeltas,
} from './context.ts'
import { registerInviteRoutes } from './inviteExchange/invite.ts'
import { getLoggerOptions, type LogLevel } from './logger.ts'
import {
  captureException,
  initSentry,
  type SentryCaptureClient,
} from './sentry.ts'
import { loadStorage, type StorageDB } from './storage.ts'
import { createUpdateChecker, type UpdateChecker } from './updateCheck.ts'
import { registerClientRoutes } from './ws/client.ts'
import { registerUplinkRoute } from './ws/uplink.ts'

// Re-exported so existing importers (and the test suite) keep a single stable
// entry point even though these now live in focused modules.
export { initialInviteCodes, type BootstrapResult } from './bootstrap.ts'
export {
  parseTrustProxy,
  resolveListenPort,
  SESSION_COOKIE_NAME,
} from './config.ts'
export { queueWebSocketMessages } from './wsSupport.ts'

export interface AppOptions {
  baseURL: string
  clientStaticPath: string
}

export async function initApp({
  baseURL,
  clientStaticPath,
  db: injectedDb,
  logLevel,
  logStream,
  sentryEnabled: injectedSentryEnabled,
  sentryClient,
  scryptParams,
  trustProxy: injectedTrustProxy,
  updateChecker: injectedUpdateChecker,
}: AppOptions & {
  db?: StorageDB
  /**
   * Test-only override for the token-hashing work factor. Omitted everywhere
   * but in tests, so a deployment always gets `DEFAULT_SCRYPT_PARAMS`.
   */
  scryptParams?: ScryptParams
  /** Overrides the level from `LOG_LEVEL` (used by tests to silence or widen output). */
  logLevel?: LogLevel
  /** Test-only sink for log output; defaults to pino's stdout destination. */
  logStream?: { write(line: string): void }
  /** Test-only override so specs can exercise Sentry-enabled paths without a real DSN. */
  sentryEnabled?: boolean
  /** Test-only override for the client `captureException(...)` reports to. */
  sentryClient?: SentryCaptureClient
  /** Test-only override for Fastify trustProxy (else STREAMWALL_TRUST_PROXY / false). */
  trustProxy?: boolean | string
  /** Injectable so specs exercise `/admin/status` without reaching GitHub. */
  updateChecker?: UpdateChecker
}) {
  const expectedOrigin = new URL(baseURL).origin
  const isSecure = baseURL.startsWith('https')

  const trustProxy =
    injectedTrustProxy ?? parseTrustProxy(process.env.STREAMWALL_TRUST_PROXY)
  const app = Fastify({
    trustProxy,
    logger: {
      ...getLoggerOptions(logLevel),
      ...(logStream && { stream: logStream }),
    },
  })

  const db = injectedDb ?? (await loadStorage())
  const auth = new Auth(db.data.auth, app.log, { scryptParams })
  const updateChecker =
    injectedUpdateChecker ?? createUpdateChecker({ log: app.log })

  // Opt-in crash reporting (see sentry.ts for why there is no default DSN).
  // Must be wired up before routes are registered so their errors are covered.
  const sentryEnabled = injectedSentryEnabled ?? initSentry(app.log)
  if (sentryEnabled) {
    Sentry.setupFastifyErrorHandler(app)
  }

  // WebSocket message handling and doc-update delivery run outside Fastify's
  // request lifecycle, so `setupFastifyErrorHandler` never sees their errors —
  // they are caught locally and reported through here instead. This includes
  // the sites that wrap a bare `ws.send()`: `ws` does not throw for the routine
  // case of sending to an already-closing socket (it silently buffers via its
  // internal `sendAfterClose` path), so a throw out of `send()` signals a
  // genuine anomaly (e.g. a payload serialization failure), not client churn.
  const reportCaughtError = (err: unknown) =>
    captureException(err, sentryEnabled, sentryClient)

  const clients = new Map<string, Client>()
  const broadcastStateDeltas = createBroadcastStateDeltas(
    clients,
    reportCaughtError,
    app.log,
  )

  const rateLimitConfig = getRateLimitConfig()

  const ctx: AppContext = {
    log: app.log,
    auth,
    updateChecker,
    expectedOrigin,
    isSecure,
    wsMessageLimitConfig: getWsMessageLimitConfig(),
    docUpdateLimits: getDocUpdateLimits(),
    clients,
    currentStreamwallWs: null,
    currentStreamwallConn: null,
    broadcastStateDeltas,
    reportCaughtError,
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
  await app.register(fastifyRateLimit, {
    global: true,
    max: rateLimitConfig.globalMax,
    timeWindow: rateLimitConfig.timeWindow,
  })

  await app.register(fastifyWebsocket, {
    errorHandler: (err) => {
      app.log.warn({ err }, 'Error handling socket request')
    },
  })

  await registerInviteRoutes(app, {
    auth,
    isSecure,
    authRateLimit: {
      max: rateLimitConfig.authMax,
      timeWindow: rateLimitConfig.timeWindow,
    },
  })
  registerUplinkRoute(app, ctx)
  registerClientRoutes(app, ctx, { clientStaticPath })

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

    ctx.currentStreamwallConn?.clientState.update({ auth: auth.getState() })
  })

  return { app, db, auth, updateChecker }
}

// `runServer` and the bootstrap helpers live in `./bootstrap.ts`; re-exported
// here so `./index.ts` stays the process entry point and stable public module.
export { default } from './bootstrap.ts'

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
