import { createHash } from 'node:crypto'
import type { AuthTokenInfo } from 'streamwall-shared'
import type { Auth } from './auth.ts'
import { systemClock, type Clock } from './rateLimiter.ts'

/**
 * How long a verified credential may be reused without deriving again. Long
 * enough to outlast the liveness ping that keeps a connected peer's entry
 * warm, so a room full of clients reconnecting after an uplink flap is served
 * from the cache rather than deriving — and being throttled — as a herd.
 * A revocation the server performed itself clears the cache outright, so this
 * only bounds how long one made elsewhere could linger.
 */
const DEFAULT_VERIFIED_TOKEN_TTL_MS = 60_000

/** Upper bound on remembered credentials, so the cache cannot grow unbounded. */
const DEFAULT_VERIFIED_TOKEN_MAX_ENTRIES = 1000

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
   * Whether the caller must be charged for a scrypt derivation: false only when
   * the credential is already verified, or when a verification it will simply
   * join is already running. Both cases provably cost no scrypt work, so the
   * strict budget stays an honest bound — the classification may over-charge a
   * cold burst, never under-charge.
   */
  willDerive(kind: VerifiedTokenKind, tokenId: string, secret: string): boolean
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
  // Verifications already running, so a burst arriving on one credential while
  // the first derivation is in flight joins it instead of each running its own.
  const pending = new Map<string, Promise<AuthTokenInfo | null>>()

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
      return !pending.has(keyFor(kind, tokenId, secret))
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
