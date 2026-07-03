import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type Clock, TokenBucket } from './rateLimiter.ts'

class FakeClock implements Clock {
  private t = 0
  now() {
    return this.t
  }
  advance(ms: number) {
    this.t += ms
  }
}

test('allows up to capacity immediately, then refuses', () => {
  const bucket = new TokenBucket({ capacity: 3, refillPerSec: 1 })

  assert.equal(bucket.tryConsume(), true)
  assert.equal(bucket.tryConsume(), true)
  assert.equal(bucket.tryConsume(), true)
  assert.equal(bucket.tryConsume(), false)
})

test('refills tokens over time at refillPerSec', () => {
  const clock = new FakeClock()
  const bucket = new TokenBucket({ capacity: 2, refillPerSec: 10, clock })

  assert.equal(bucket.tryConsume(), true)
  assert.equal(bucket.tryConsume(), true)
  assert.equal(bucket.tryConsume(), false)

  // 10 tokens/sec -> 100ms restores exactly one token.
  clock.advance(100)
  assert.equal(bucket.tryConsume(), true)
  assert.equal(bucket.tryConsume(), false)
})

test('never accumulates more than capacity while idle', () => {
  const clock = new FakeClock()
  const bucket = new TokenBucket({ capacity: 2, refillPerSec: 100, clock })

  // Drain, then idle far longer than needed to refill.
  bucket.tryConsume()
  bucket.tryConsume()
  clock.advance(60_000)

  assert.equal(bucket.tryConsume(), true)
  assert.equal(bucket.tryConsume(), true)
  assert.equal(bucket.tryConsume(), false)
})

test('a request larger than capacity can never be satisfied', () => {
  const bucket = new TokenBucket({ capacity: 2, refillPerSec: 1 })
  assert.equal(bucket.tryConsume(5), false)
  // The failed attempt does not drain the bucket.
  assert.equal(bucket.tryConsume(2), true)
})
