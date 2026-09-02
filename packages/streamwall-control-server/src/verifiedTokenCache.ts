import { createHash } from 'node:crypto'
import type { AuthTokenInfo } from 'streamwall-shared'
import type { Auth } from './auth.ts'
import { systemClock, type Clock } from './rateLimiter.ts'

/** How long a verified credential may be reused without deriving again. */
export const DEFAULT_VERIFIED_TOKEN_TTL_MS = 10_000

/** Upper bound on remembered credentials, so the cache cannot grow unbounded. */
export const DEFAULT_VERIFIED_TOKEN_MAX_ENTRIES = 1000

export interface VerifiedTokenCache {
  /** The remembered identity for this credential, or null if there is none. */
  get(tokenId: string, secret: string): AuthTokenInfo | null
  /** Remembers a successful verification. Failures are never cached. */
  set(tokenId: string, secret: string, identity: AuthTokenInfo): void
  /** Forgets everything (used when the token set changes). */
  clear(): void
}

/**
 * Remembers recently verified credentials — session cookies and the uplink's
 * bearer token — for a few seconds.
 *
 * Verifying one means a full scrypt derivation (`N=16384`, ~16 MiB and tens of
 * milliseconds of libuv-threadpool work). Without this, an authenticated page
 * load paid one derivation per request and a reconnecting peer paid one per
 * attempt, which is both a latency problem and the amplification an attacker
 * needs to saturate the thread pool (issue #735).
 *
 * Only successful verifications are cached, so an unknown token id still hashes
 * unconditionally and reveals nothing by timing. Entries are keyed by a digest
 * rather than the credential itself, so a live secret is never held in a map
 * that outlives the request that carried it. The cache is dropped whenever the
 * auth state changes, so revoking a token takes effect at once rather than
 * after the TTL.
 */
export function createVerifiedTokenCache({
  auth,
  ttlMs = DEFAULT_VERIFIED_TOKEN_TTL_MS,
  maxEntries = DEFAULT_VERIFIED_TOKEN_MAX_ENTRIES,
  clock = systemClock,
}: {
  auth: Pick<Auth, 'on'>
  ttlMs?: number
  maxEntries?: number
  clock?: Clock
}): VerifiedTokenCache {
  const entries = new Map<
    string,
    { identity: AuthTokenInfo; expiresAt: number }
  >()

  // The id and the secret are digested together with a separator that can
  // occur in neither, so no two distinct credentials can collide on one key.
  const keyFor = (tokenId: string, secret: string) =>
    createHash('sha256').update(`${tokenId}\0${secret}`).digest('base64')

  const cache: VerifiedTokenCache = {
    get(tokenId, secret) {
      const key = keyFor(tokenId, secret)
      const entry = entries.get(key)
      if (!entry) {
        return null
      }
      if (entry.expiresAt <= clock.now()) {
        entries.delete(key)
        return null
      }
      return entry.identity
    },
    set(tokenId, secret, identity) {
      // Insertion order is eviction order: a full cache drops its oldest entry,
      // which costs that peer one extra derivation and nothing else.
      if (entries.size >= maxEntries) {
        const oldest = entries.keys().next()
        if (!oldest.done) {
          entries.delete(oldest.value)
        }
      }
      entries.set(keyFor(tokenId, secret), {
        identity,
        expiresAt: clock.now() + ttlMs,
      })
    },
    clear() {
      entries.clear()
    },
  }

  // Any token change — an invite redeemed, a session revoked, the uplink token
  // rotated — invalidates every remembered verification. Active peers are few,
  // so the bluntness costs one derivation each at worst.
  auth.on('state', () => cache.clear())

  return cache
}
