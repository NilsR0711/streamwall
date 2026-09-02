import { createHash } from 'node:crypto'
import type { AuthTokenInfo } from 'streamwall-shared'
import type { Auth } from './auth.ts'
import { systemClock, type Clock } from './rateLimiter.ts'

/** How long a verified credential may be reused without deriving again. */
export const DEFAULT_VERIFIED_TOKEN_TTL_MS = 10_000

/**
 * How long a charged-but-unstarted derivation keeps other requests on the same
 * credential from being charged as well. Only a request that never reaches the
 * verification at all leans on this; the rest release their claim when the
 * verification settles.
 */
export const DEFAULT_DERIVATION_CLAIM_TTL_MS = 5_000

/** Upper bound on remembered credentials, so the cache cannot grow unbounded. */
export const DEFAULT_VERIFIED_TOKEN_MAX_ENTRIES = 1000

/** The kind of credential a lookup expects, so the two can never be swapped. */
export type VerifiedTokenKind = AuthTokenInfo['kind']

export interface VerifiedTokenCache {
  /** The remembered identity for this credential, or null if there is none. */
  get(
    kind: VerifiedTokenKind,
    tokenId: string,
    secret: string,
  ): AuthTokenInfo | null
  /**
   * Whether the caller must be charged for a scrypt derivation: false when the
   * credential is already verified, when a verification for it is running, and
   * when another request has just claimed the derivation it will share. Claiming
   * is a side effect, so this is called exactly once per request.
   */
  willDerive(kind: VerifiedTokenKind, tokenId: string, secret: string): boolean
  /**
   * Gives back a claim `willDerive` handed out for a request that never got as
   * far as verifying — a throttled one, most of all, which would otherwise buy
   * the next attempt on the same credential a free derivation.
   */
  releaseClaim(kind: VerifiedTokenKind, tokenId: string, secret: string): void
  /**
   * Returns the remembered identity, joins a verification already in flight for
   * the same credential, or runs `derive` and remembers a matching result.
   * Only a result of the requested kind is cached; failures never are.
   */
  verify(
    kind: VerifiedTokenKind,
    tokenId: string,
    secret: string,
    derive: () => Promise<AuthTokenInfo | null>,
  ): Promise<AuthTokenInfo | null>
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
  claimTtlMs = DEFAULT_DERIVATION_CLAIM_TTL_MS,
  clock = systemClock,
}: {
  auth: Pick<Auth, 'on'>
  ttlMs?: number
  maxEntries?: number
  claimTtlMs?: number
  clock?: Clock
}): VerifiedTokenCache {
  const entries = new Map<
    string,
    { identity: AuthTokenInfo; expiresAt: number }
  >()
  // Verifications already running, so a herd of requests arriving on one
  // credential before the first derivation finishes costs one derivation
  // rather than one each — which is also what keeps them off the strict
  // rate-limit budget that exists to bound real scrypt work.
  const pending = new Map<string, Promise<AuthTokenInfo | null>>()
  // Derivations a request has been charged for but not yet started: the rate
  // limiter classifies a request before the handler runs, so without this the
  // whole herd would be classified — and charged — before the first of them
  // reaches the verification they all end up sharing.
  const claims = new Map<string, number>()

  // The kind, the id and the secret are digested together with a separator
  // that can occur in none of them, so no two distinct credentials collide on
  // one key — and a session lookup can never be answered with the uplink's
  // identity, which would hand a desktop token a browser session's authority.
  const keyFor = (kind: VerifiedTokenKind, tokenId: string, secret: string) =>
    createHash('sha256')
      .update(`${kind}\0${tokenId}\0${secret}`)
      .digest('base64')

  const remember = (
    kind: VerifiedTokenKind,
    tokenId: string,
    secret: string,
    identity: AuthTokenInfo,
  ) => {
    const key = keyFor(kind, tokenId, secret)
    // Re-inserting must not evict anyone: delete first so an existing key
    // neither counts towards the bound nor keeps its original (stale)
    // position in the eviction order.
    entries.delete(key)
    // Insertion order is eviction order: a full cache drops its oldest entry,
    // which costs that peer one extra derivation and nothing else.
    if (entries.size >= maxEntries) {
      const oldest = entries.keys().next()
      if (!oldest.done) {
        entries.delete(oldest.value)
      }
    }
    entries.set(key, { identity, expiresAt: clock.now() + ttlMs })
  }

  const cache: VerifiedTokenCache = {
    get(kind, tokenId, secret) {
      const key = keyFor(kind, tokenId, secret)
      const entry = entries.get(key)
      if (!entry) {
        return null
      }
      const now = clock.now()
      if (entry.expiresAt <= now) {
        entries.delete(key)
        return null
      }
      // The TTL slides: it exists to bound how long a revocation the server
      // never saw could linger, and every clear() already covers the ones it
      // does see. A fixed expiry would instead make a peer that reconnects
      // continuously — the flapping desktop this cache is for — re-derive on a
      // timer and spend the strict budget it was meant to stay out of.
      entry.expiresAt = now + ttlMs
      return entry.identity
    },
    willDerive(kind, tokenId, secret) {
      if (cache.get(kind, tokenId, secret)) {
        return false
      }
      const key = keyFor(kind, tokenId, secret)
      if (pending.has(key)) {
        return false
      }
      const claimedAt = claims.get(key)
      const now = clock.now()
      // A claim is released as soon as its verification settles; the deadline
      // only covers a request that is charged and then never verifies at all
      // (rejected further down the chain, or a socket that dies first).
      if (claimedAt !== undefined && now - claimedAt < claimTtlMs) {
        return false
      }
      if (claims.size >= maxEntries) {
        const oldest = claims.keys().next()
        if (!oldest.done) {
          claims.delete(oldest.value)
        }
      }
      claims.set(key, now)
      return true
    },
    releaseClaim(kind, tokenId, secret) {
      claims.delete(keyFor(kind, tokenId, secret))
    },
    async verify(kind, tokenId, secret, derive) {
      const known = cache.get(kind, tokenId, secret)
      if (known) {
        return known
      }
      const key = keyFor(kind, tokenId, secret)
      const inFlight = pending.get(key)
      if (inFlight) {
        return inFlight
      }
      const running = derive()
        .then((identity) => {
          if (identity && identity.kind === kind) {
            remember(kind, tokenId, secret, identity)
          }
          return identity
        })
        .finally(() => {
          pending.delete(key)
          claims.delete(key)
        })
      pending.set(key, running)
      return running
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
