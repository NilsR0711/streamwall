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
  return { cache, auth, advance: (ms: number) => (now += ms) }
}

describe('createVerifiedTokenCache', () => {
  test('remembers a verification and hands it back', () => {
    const { cache } = harness()
    cache.set('session', 'abc', 'secret', IDENTITY)

    assert.equal(cache.get('session', 'abc', 'secret'), IDENTITY)
  })

  test('never confuses one credential for another', () => {
    const { cache } = harness()
    cache.set('session', 'abc', 'secret', IDENTITY)

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

  test('a credential verified for one kind is never returned for another', () => {
    // The uplink's bearer token and a browser session cookie carry very
    // different authority; answering a session lookup with the uplink's
    // identity would hand a desktop credential a browser session's rights.
    const { cache } = harness()
    cache.set('streamwall', 'abc', 'secret', IDENTITY)

    assert.equal(cache.get('session', 'abc', 'secret'), null)
    assert.equal(cache.get('streamwall', 'abc', 'secret'), IDENTITY)
  })

  test('forgets an entry once its TTL has passed unused', () => {
    const { cache, advance } = harness({ ttlMs: 5000 })
    cache.set('session', 'abc', 'secret', IDENTITY)

    advance(4999)
    assert.equal(cache.get('session', 'abc', 'secret'), IDENTITY)

    advance(5001)
    assert.equal(
      cache.get('session', 'abc', 'secret'),
      null,
      'an expired verification must be re-derived',
    )
  })

  test('a credential in continuous use keeps its entry alive', () => {
    // A peer that reconnects every few seconds must not be dropped on a timer
    // and pushed back onto the strict rate-limit budget.
    const { cache, advance } = harness({ ttlMs: 5000 })
    cache.set('session', 'abc', 'secret', IDENTITY)

    for (let i = 0; i < 5; i++) {
      advance(4000)
      assert.equal(cache.get('session', 'abc', 'secret'), IDENTITY)
    }
  })

  test('evicts the oldest entry rather than growing without bound', () => {
    const { cache } = harness({ maxEntries: 2 })
    cache.set('session', 'one', 's', IDENTITY)
    cache.set('session', 'two', 's', IDENTITY)
    cache.set('session', 'three', 's', IDENTITY)

    assert.equal(
      cache.get('session', 'one', 's'),
      null,
      'the oldest entry is dropped',
    )
    assert.equal(cache.get('session', 'two', 's'), IDENTITY)
    assert.equal(cache.get('session', 'three', 's'), IDENTITY)
  })

  test('re-verifying a known credential evicts nobody', () => {
    const { cache } = harness({ maxEntries: 2 })
    cache.set('session', 'one', 's', IDENTITY)
    cache.set('session', 'two', 's', IDENTITY)
    cache.set('session', 'two', 's', IDENTITY)

    assert.equal(
      cache.get('session', 'one', 's'),
      IDENTITY,
      're-inserting an existing key must not push another peer out',
    )
  })

  test('drops everything as soon as the token set changes', () => {
    const { cache, auth } = harness()
    cache.set('session', 'abc', 'secret', IDENTITY)

    auth.emit('state', { invites: [], sessions: [] })

    assert.equal(
      cache.get('session', 'abc', 'secret'),
      null,
      'a revoked token must not keep working until the TTL expires',
    )
  })
})
