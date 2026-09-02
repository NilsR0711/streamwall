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
    cache.set('abc', 'secret', IDENTITY)

    assert.equal(cache.get('abc', 'secret'), IDENTITY)
  })

  test('never confuses one credential for another', () => {
    const { cache } = harness()
    cache.set('abc', 'secret', IDENTITY)

    assert.equal(cache.get('abc', 'other'), null, 'a wrong secret must miss')
    assert.equal(cache.get('xyz', 'secret'), null, 'a wrong id must miss')
    // The id and the secret are digested with a separator, so a split at a
    // different position cannot collide with the entry above.
    assert.equal(cache.get('ab', 'csecret'), null)
  })

  test('forgets an entry once its TTL has passed', () => {
    const { cache, advance } = harness({ ttlMs: 5000 })
    cache.set('abc', 'secret', IDENTITY)

    advance(4999)
    assert.equal(cache.get('abc', 'secret'), IDENTITY)

    advance(1)
    assert.equal(
      cache.get('abc', 'secret'),
      null,
      'an expired verification must be re-derived',
    )
  })

  test('evicts the oldest entry rather than growing without bound', () => {
    const { cache } = harness({ maxEntries: 2 })
    cache.set('one', 's', IDENTITY)
    cache.set('two', 's', IDENTITY)
    cache.set('three', 's', IDENTITY)

    assert.equal(cache.get('one', 's'), null, 'the oldest entry is dropped')
    assert.equal(cache.get('two', 's'), IDENTITY)
    assert.equal(cache.get('three', 's'), IDENTITY)
  })

  test('drops everything as soon as the token set changes', () => {
    const { cache, auth } = harness()
    cache.set('abc', 'secret', IDENTITY)

    auth.emit('state', { invites: [], sessions: [] })

    assert.equal(
      cache.get('abc', 'secret'),
      null,
      'a revoked token must not keep working until the TTL expires',
    )
  })
})
