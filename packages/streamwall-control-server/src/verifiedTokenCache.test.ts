import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, test } from 'node:test'
import type { AuthTokenInfo } from 'streamwall-shared'

import type { Auth } from './auth.ts'
import type { Clock } from './rateLimiter.ts'
import { createVerifiedTokenCache } from './verifiedTokenCache.ts'

const IDENTITY: AuthTokenInfo = {
  tokenId: 'abc',
  kind: 'session',
  role: 'admin',
  name: 'session',
} as AuthTokenInfo

/** A hand-cranked clock plus the auth event emitter the cache listens on. */
function harness(options: { ttlMs?: number; maxEntries?: number } = {}) {
  let now = 1000
  const clock: Clock = { now: () => now }
  const auth = new EventEmitter() as unknown as Auth
  const cache = createVerifiedTokenCache({ auth, clock, ...options })
  /** Verifies a credential the way a route does, seeding the cache with it. */
  const seed = (
    kind: 'session' | 'streamwall',
    tokenId: string,
    secret: string,
    identity: AuthTokenInfo = { ...IDENTITY, kind },
  ) => cache.verify(kind, tokenId, secret, async () => identity)
  return { cache, auth, seed, advance: (ms: number) => (now += ms) }
}

describe('createVerifiedTokenCache', async () => {
  test('remembers a verification and hands it back', async () => {
    const { cache, seed } = harness()
    await seed('session', 'abc', 'secret', IDENTITY)

    assert.equal(cache.get('session', 'abc', 'secret'), IDENTITY)
  })

  test('never confuses one credential for another', async () => {
    const { cache, seed } = harness()
    await seed('session', 'abc', 'secret', IDENTITY)

    assert.equal(
      cache.get('session', 'abc', 'other'),
      null,
      'a wrong secret must miss',
    )
    assert.equal(
      cache.get('session', 'xyz', 'secret'),
      null,
      'a wrong id must miss',
    )
    // The parts are digested with a separator, so a split at a different
    // position cannot collide with the entry above.
    assert.equal(cache.get('session', 'ab', 'csecret'), null)
  })

  test('a credential verified for one kind is never returned for another', async () => {
    // The uplink's bearer token and a browser session cookie carry very
    // different authority; answering a session lookup with the uplink's
    // identity would hand a desktop credential a browser session's rights.
    const { cache, seed } = harness()
    const uplink = { ...IDENTITY, kind: 'streamwall' } as AuthTokenInfo
    await seed('streamwall', 'abc', 'secret', uplink)

    assert.equal(cache.get('session', 'abc', 'secret'), null)
    assert.equal(cache.get('streamwall', 'abc', 'secret'), uplink)
  })

  test('forgets an entry once its TTL has passed unused', async () => {
    const { cache, seed, advance } = harness({ ttlMs: 5000 })
    await seed('session', 'abc', 'secret', IDENTITY)

    advance(4999)
    assert.equal(cache.get('session', 'abc', 'secret'), IDENTITY)

    advance(5001)
    assert.equal(
      cache.get('session', 'abc', 'secret'),
      null,
      'an expired verification must be re-derived',
    )
  })

  test('a credential in continuous use keeps its entry alive', async () => {
    // A peer that reconnects every few seconds must not be dropped on a timer
    // and pushed back onto the strict rate-limit budget.
    const { cache, seed, advance } = harness({ ttlMs: 5000 })
    await seed('session', 'abc', 'secret', IDENTITY)

    for (let i = 0; i < 5; i++) {
      advance(4000)
      assert.equal(cache.get('session', 'abc', 'secret'), IDENTITY)
    }
  })

  test('evicts the oldest entry rather than growing without bound', async () => {
    const { cache, seed } = harness({ maxEntries: 2 })
    await seed('session', 'one', 's', IDENTITY)
    await seed('session', 'two', 's', IDENTITY)
    await seed('session', 'three', 's', IDENTITY)

    assert.equal(
      cache.get('session', 'one', 's'),
      null,
      'the oldest entry is dropped',
    )
    assert.equal(cache.get('session', 'two', 's'), IDENTITY)
    assert.equal(cache.get('session', 'three', 's'), IDENTITY)
  })

  test('re-verifying a known credential evicts nobody', async () => {
    const { cache, seed } = harness({ maxEntries: 2 })
    await seed('session', 'one', 's', IDENTITY)
    await seed('session', 'two', 's', IDENTITY)
    await seed('session', 'two', 's', IDENTITY)

    assert.equal(
      cache.get('session', 'one', 's'),
      IDENTITY,
      're-inserting an existing key must not push another peer out',
    )
  })

  test('never verifies one credential twice at the same time', async () => {
    // A herd of tabs reconnecting on one session hits the routes before the
    // first derivation finishes; without single-flighting they would each pay
    // for their own, and each be charged against the strict rate-limit budget.
    const { cache } = harness()
    let derivations = 0
    let release: (identity: AuthTokenInfo) => void = () => {}
    const derive = () => {
      derivations += 1
      return new Promise<AuthTokenInfo | null>((resolve) => {
        release = resolve
      })
    }

    const inFlight = Array.from({ length: 5 }, () =>
      cache.verify('session', 'abc', 'secret', derive),
    )
    assert.equal(
      cache.willDerive('session', 'abc', 'secret'),
      false,
      'a request joining a running verification pays for no derivation',
    )
    release(IDENTITY)
    const results = await Promise.all(inFlight)

    assert.equal(derivations, 1, 'one credential costs one derivation')
    assert.deepEqual(new Set(results), new Set([IDENTITY]))
    assert.equal(
      cache.willDerive('session', 'abc', 'secret'),
      false,
      'the finished verification is now simply a cache hit',
    )
  })

  test('charges a request only when it will really derive', async () => {
    // The classification may over-charge (a cold burst is charged per request),
    // but it must never let a derivation through uncharged.
    const { cache, seed } = harness()

    assert.equal(
      cache.willDerive('session', 'abc', 'secret'),
      true,
      'an unknown credential has to be derived, so it is charged',
    )

    let release: (identity: AuthTokenInfo) => void = () => {}
    const inFlight = cache.verify(
      'session',
      'abc',
      'secret',
      () =>
        new Promise<AuthTokenInfo | null>((resolve) => {
          release = resolve
        }),
    )
    assert.equal(
      cache.willDerive('session', 'abc', 'secret'),
      false,
      'joining a running verification costs no derivation of its own',
    )
    release(IDENTITY)
    await inFlight

    assert.equal(
      cache.willDerive('session', 'abc', 'secret'),
      false,
      'a cache hit costs no derivation either',
    )

    await seed('session', 'other', 'secret')
    assert.equal(cache.willDerive('session', 'unknown', 'secret'), true)
  })

  test('a result of the wrong kind is never remembered', async () => {
    // Defence in depth behind the routes' own kind checks: a derive that comes
    // back with another kind must not seed this kind's entry.
    const { cache } = harness()
    const uplink = { ...IDENTITY, kind: 'streamwall' } as AuthTokenInfo

    const result = await cache.verify(
      'session',
      'abc',
      'secret',
      async () => uplink,
    )

    assert.equal(result, uplink, 'the caller still sees what it derived')
    assert.equal(
      cache.get('session', 'abc', 'secret'),
      null,
      'but nothing of another kind is cached under this one',
    )
  })

  test('drops everything as soon as the token set changes', async () => {
    const { cache, auth, seed } = harness()
    await seed('session', 'abc', 'secret', IDENTITY)

    auth.emit('state', { invites: [], sessions: [] })

    assert.equal(
      cache.get('session', 'abc', 'secret'),
      null,
      'a revoked token must not keep working until the TTL expires',
    )
  })
})
