import { describe, expect, test, vi } from 'vitest'

// `node-fetch` is mocked at the module level (rather than driving a real
// server, as `poll.test.ts` does) so this test can assert on the exact
// `resp.body.resume()` call `pollDataURL` is supposed to make, without
// picking up any of the several unrelated internal `resume()` calls Node's
// own HTTP client/server machinery makes while a real request is in flight.
const resume = vi.fn()

vi.mock('node-fetch', () => ({
  default: vi.fn(async () => ({
    ok: false,
    status: 503,
    statusText: 'Service Unavailable',
    body: { resume },
    json: vi.fn(async () => {
      throw new Error('body should never be read on a non-2xx response')
    }),
  })),
}))

const { pollDataURL } = await import('./poll')

describe('pollDataURL non-2xx body draining (issue #817)', () => {
  // Leaving a non-2xx response's body unread holds its connection open
  // until GC reclaims it, on every failing poll. Draining it immediately
  // instead releases the connection back to the pool.
  test('drains the unread body of a non-2xx response instead of leaving it dangling', async () => {
    const onHealth = vi.fn()
    const gen = pollDataURL('http://example.invalid/', 999, onHealth)
    try {
      await gen.next()
      expect(resume).toHaveBeenCalledTimes(1)
      expect(onHealth).toHaveBeenCalledWith(
        false,
        expect.stringContaining('503'),
      )
    } finally {
      await gen.return(undefined)
    }
  })
})
