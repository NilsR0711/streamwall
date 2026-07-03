export interface Clock {
  /** Current time in milliseconds. */
  now(): number
}

export const systemClock: Clock = { now: () => Date.now() }

export interface TokenBucketOptions {
  /** Maximum number of tokens (i.e. the burst allowance). */
  capacity: number
  /** Sustained refill rate in tokens per second. */
  refillPerSec: number
  clock?: Clock
}

/**
 * A classic token-bucket rate limiter. Starts full so short bursts up to
 * `capacity` are allowed, then refills continuously at `refillPerSec`.
 *
 * Used to bound the rate of inbound WebSocket messages per connection.
 */
export class TokenBucket {
  private tokens: number
  private lastRefill: number
  private readonly capacity: number
  private readonly refillPerSec: number
  private readonly clock: Clock

  constructor({
    capacity,
    refillPerSec,
    clock = systemClock,
  }: TokenBucketOptions) {
    this.capacity = capacity
    this.refillPerSec = refillPerSec
    this.clock = clock
    this.tokens = capacity
    this.lastRefill = clock.now()
  }

  /**
   * Attempts to consume `count` tokens. Returns true and deducts them if
   * enough are available, otherwise returns false and leaves the bucket
   * untouched.
   */
  tryConsume(count = 1): boolean {
    this.refill()
    if (this.tokens >= count) {
      this.tokens -= count
      return true
    }
    return false
  }

  private refill(): void {
    const now = this.clock.now()
    const elapsedSec = (now - this.lastRefill) / 1000
    if (elapsedSec <= 0) {
      return
    }
    this.tokens = Math.min(
      this.capacity,
      this.tokens + elapsedSec * this.refillPerSec,
    )
    this.lastRefill = now
  }
}
