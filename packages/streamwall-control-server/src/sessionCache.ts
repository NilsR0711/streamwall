import type { AuthTokenInfo } from 'streamwall-shared'
import type { Auth } from './auth.ts'
import { systemClock, type Clock } from './rateLimiter.ts'

/** How long a verified session cookie may be reused without re-deriving. */
export const DEFAULT_SESSION_CACHE_TTL_MS = 10_000

/** Upper bound on remembered sessions, so the cache cannot grow unbounded. */
export const DEFAULT_SESSION_CACHE_MAX_ENTRIES = 1000

export interface SessionCache {
  /** The remembered identity for `cookie`, or null if there is none. */
  get(cookie: string): AuthTokenInfo | null
  /** Remembers a successful verification. Failures are never cached. */
  set(cookie: string, identity: AuthTokenInfo): void
  /** Forgets everything (used when the token set changes). */
  clear(): void
}

/**
 * Remembers recently verified session cookies for a few seconds.
 *
 * Verifying a cookie means a full scrypt derivation (`N=16384`, ~16 MiB and
 * tens of milliseconds of libuv-threadpool work). Without this, an authenticated
 * page load paid one derivation per request, and an attacker could amplify a
 * trickle of requests into saturation of the whole thread pool.
 *
 * Only successful verifications are cached, so an unknown token id still hashes
 * unconditionally and reveals nothing by timing. The cache is dropped whenever
 * the auth state changes, so revoking a session takes effect at once rather
 * than after the TTL.
 */
export function createSessionCache({
  auth,
  ttlMs = DEFAULT_SESSION_CACHE_TTL_MS,
  maxEntries = DEFAULT_SESSION_CACHE_MAX_ENTRIES,
  clock = systemClock,
}: {
  auth: Pick<Auth, 'on'>
  ttlMs?: number
  maxEntries?: number
  clock?: Clock
}): SessionCache {
  const entries = new Map<
    string,
    { identity: AuthTokenInfo; expiresAt: number }
  >()

  const cache: SessionCache = {
    get(cookie) {
      const entry = entries.get(cookie)
      if (!entry) {
        return null
      }
      if (entry.expiresAt <= clock.now()) {
        entries.delete(cookie)
        return null
      }
      return entry.identity
    },
    set(cookie, identity) {
      // Insertion order is eviction order: a full cache drops its oldest entry,
      // which costs that session one extra derivation and nothing else.
      if (entries.size >= maxEntries) {
        const oldest = entries.keys().next()
        if (!oldest.done) {
          entries.delete(oldest.value)
        }
      }
      entries.set(cookie, { identity, expiresAt: clock.now() + ttlMs })
    },
    clear() {
      entries.clear()
    },
  }

  // Any token change — an invite redeemed, a session revoked — invalidates
  // every remembered verification. Sessions are few and short-lived, so the
  // bluntness costs one derivation per active client at worst.
  auth.on('state', () => cache.clear())

  return cache
}
