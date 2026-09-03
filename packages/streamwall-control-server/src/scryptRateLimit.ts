import type {
  FastifyInstance,
  FastifyRequest,
  onRequestAsyncHookHandler,
} from 'fastify'

import type { RateLimitConfig } from './config.ts'

/** Where a request remembers whether it was charged for a derivation. */
const DERIVES = Symbol('streamwall.derivesToken')

/**
 * Decides whether serving this request will have to run a scrypt derivation.
 * Each deriving route supplies its own — the browser surface reads the session
 * cookie, the uplink its bearer token — and declares it in the route's config
 * so the one shared limiter can ask without knowing the routes.
 */
export type DerivationClassifier = (request: FastifyRequest) => boolean

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * Set on every route guarded by the shared scrypt limiter. Its absence
     * means the route never derives, so it stays on the global budget.
     */
    scryptDerives?: DerivationClassifier
  }
}

/**
 * Builds the single limiter shared by every scrypt-deriving route.
 *
 * `@fastify/rate-limit` gives each route carrying its own `config.rateLimit`
 * object a private store (`store.child()` returns a fresh LRU), so per-route
 * configs meant one independent budget per route — four times the ceiling the
 * strict limit documents (issue #821). One limiter instance built here holds
 * one store, and the routes attach it as their `onRequest` hook, so the whole
 * scrypt-deriving surface spends a single per-IP budget.
 *
 * The bucket separation introduced with the strict limit (issue #735) is
 * unchanged: only a request that will actually derive is charged to
 * `<ip>:derive`; a request riding a credential the server already verified —
 * or carrying none at all — stays on `<ip>:verified` at the global budget, so
 * an attacker spraying unknown credentials can never lock a known operator out
 * of their own socket.
 */
export function createScryptRateLimit(
  app: FastifyInstance,
  rateLimit: RateLimitConfig,
): onRequestAsyncHookHandler {
  /**
   * `keyGenerator` and `max` both run per request and must agree, so the
   * classification is computed once and remembered on the request rather than
   * re-derived from a cache that may have changed in between.
   */
  const derivesOnce = (request: FastifyRequest): boolean => {
    const memo = request as unknown as Record<symbol, boolean | undefined>
    memo[DERIVES] ??=
      request.routeOptions.config?.scryptDerives?.(request) ?? false
    return memo[DERIVES]
  }

  // Typed as a `preHandler` handler by the plugin's declarations, but the
  // handler it builds only ever takes `(request, reply)` and its own default
  // hook is `onRequest` — which is where this has to run, so a handshake or a
  // request body is refused before anything parses it.
  return app.rateLimit({
    keyGenerator: (request: FastifyRequest) =>
      `${request.ip}:${derivesOnce(request) ? 'derive' : 'verified'}`,
    max: (request: FastifyRequest) =>
      derivesOnce(request) ? rateLimit.authMax : rateLimit.globalMax,
    timeWindow: rateLimit.timeWindow,
  }) as unknown as onRequestAsyncHookHandler
}
