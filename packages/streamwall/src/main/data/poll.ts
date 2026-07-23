import fetch from 'node-fetch'
import { StreamDataContent } from '../../../../streamwall-shared/src/types'
import log from '../logger'
import { parseStreamEntries } from './parse'
import type { DataSourceHealthCallback } from './types'

// Deliberately not `promisify(setTimeout)` at module scope: that binds to
// whatever `setTimeout` function is global at import time, which is the
// real one - a test that swaps in vi.useFakeTimers() afterwards cannot
// intercept an already-captured reference. Resolving `setTimeout` fresh
// inside the function body, on every call, is what lets fake timers control
// pollDataURL's inter-poll wait (poll.test.ts).
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// A stalled `fetch(url)` (a host that accepts the connection and never
// answers) must not hang pollDataURL's loop forever - see #603. The timeout
// tracks the poll interval (half of it) so a slower configured interval
// tolerates a proportionally slower endpoint, but is clamped to a band:
// - a floor high enough that a merely-slow response on a short interval
//   (including the sub-second intervals this module's own tests use) is not
//   misreported as a dead source,
// - a ceiling so a very long interval doesn't leave an operator waiting
//   minutes to learn a source is unreachable.
export const MIN_FETCH_TIMEOUT_MS = 5_000
export const MAX_FETCH_TIMEOUT_MS = 15_000

export function computeFetchTimeoutMs(refreshIntervalMs: number): number {
  return Math.min(
    MAX_FETCH_TIMEOUT_MS,
    Math.max(MIN_FETCH_TIMEOUT_MS, refreshIntervalMs / 2),
  )
}

// Deliberately built on a manual AbortController + setTimeout rather than
// the built-in `AbortSignal.timeout()`: the latter schedules its internal
// timer through Node's C++ timer binding, which vitest's fake-timers (used
// by poll.test.ts to drive the timeout deterministically) cannot intercept.
// A timer created via the global `setTimeout` used elsewhere in this module
// is reliably fake-timer-controllable.
async function fetchWithTimeout(url: string, timeoutMs: number) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { signal: controller.signal })
  } catch (err) {
    // node-fetch's AbortError carries a generic "The operation was aborted."
    // message regardless of the abort reason, so a timeout looks the same
    // as any other cancellation. Re-throw with a message that names the
    // actual cause and duration, which is what ends up surfaced to the
    // operator via onHealth(false, message).
    if (controller.signal.aborted) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${url}`, {
        cause: err,
      })
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

// The `await fetchWithTimeout(...)` below sits inside a loop, but this is a
// polling *interval* loop over a single endpoint, not a fan-out over
// independent items: iteration N is one refresh cycle of the same URL and
// must not start before iteration N-1 has finished and the interval has
// elapsed. Batching or parallelising the iterations would turn a paced
// poller into an unbounded request flood against the operator's endpoint.
// Concurrency across data sources already exists one level up:
// `buildDataSources` creates one generator per URL and `combineDataSources`
// advances all of them at once via `latestPerSource`, so N URLs are polled
// in parallel with each other while each individual URL stays strictly
// serial (see #582).
export async function* pollDataURL(
  url: string,
  intervalSecs: number,
  onHealth?: DataSourceHealthCallback,
) {
  const refreshInterval = intervalSecs * 1000
  const fetchTimeout = computeFetchTimeoutMs(refreshInterval)
  let lastData: StreamDataContent[] = []
  while (true) {
    let data: StreamDataContent[] = []
    try {
      const resp = await fetchWithTimeout(url, fetchTimeout)
      data = parseStreamEntries(await resp.json(), `from ${url}`)
      onHealth?.(true)
    } catch (err) {
      log.warn('error loading stream data', err)
      onHealth?.(false, err instanceof Error ? err.message : String(err))
    }

    // If the endpoint errors or returns an empty dataset, keep the cached data.
    if (!data.length && lastData.length) {
      log.warn('using cached stream data')
    } else {
      yield data
      lastData = data
    }

    await sleep(refreshInterval)
  }
}
