import TOML from '@iarna/toml'
import { Repeater } from '@repeaterjs/repeater'
import { watch } from 'chokidar'
import { EventEmitter, once } from 'events'
import { promises as fsPromises } from 'fs'
import fetch from 'node-fetch'
import { parseStreamList } from 'streamwall-shared'
import {
  StreamData,
  StreamDataContent,
  StreamList,
} from '../../../streamwall-shared/src/types'
import log from './logger'
import type { PresetPack } from './presets'

// Deliberately not `promisify(setTimeout)` at module scope: that binds to
// whatever `setTimeout` function is global at import time, which is the
// real one - a test that swaps in vi.useFakeTimers() afterwards cannot
// intercept an already-captured reference. Resolving `setTimeout` fresh
// inside the function body, on every call, is what lets fake timers control
// pollDataURL's inter-poll wait (data.test.ts).
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type DataSource = AsyncIterableIterator<StreamDataContent[]>

// A stalled `fetch(url)` (a host that accepts the connection and never
// answers) must not hang pollDataURL's loop forever - see #603. The timeout
// tracks the poll interval (half of it) so a slower configured interval
// tolerates a proportionally slower endpoint, but is clamped to a band:
// - a floor high enough that a merely-slow response on a short interval
//   (including the sub-second intervals this file's own tests use) is not
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
// by data.test.ts to drive the timeout deterministically) cannot intercept.
// A timer created via the global `setTimeout` used elsewhere in this file
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

// Reports whether the most recent read of a data source succeeded, so a
// caller can surface a dead json-url/toml-file from the UI instead of it
// only being diagnosable from a log.
export type DataSourceHealthCallback = (ok: boolean, message?: string) => void

// The `await fetch(...)` below sits inside a loop, but this is a polling
// *interval* loop over a single endpoint, not a fan-out over independent
// items: iteration N is one refresh cycle of the same URL and must not start
// before iteration N-1 has finished and the interval has elapsed. Batching or
// parallelising the iterations would turn a paced poller into an unbounded
// request flood against the operator's endpoint. Concurrency across data
// sources already exists one level up: `buildDataSources` creates one
// generator per URL and `combineDataSources` advances all of them at once via
// `latestPerSource`, so N URLs are polled in parallel with each other while
// each individual URL stays strictly serial (see #582).
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
      const { streams, errors } = parseStreamList(await resp.json())
      if (errors.length) {
        log.warn(`ignoring ${errors.length} invalid stream(s) from ${url}`)
      }
      data = streams as StreamDataContent[]
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

// Like `pollDataURL`, the `await fsPromises.readFile(path)` below is inside a
// loop, but the loop is event-driven over a single file: each iteration is
// triggered by a filesystem event for that one path, so there is nothing
// independent to fan out over. Reading ahead would just re-read the same file.
// Multiple watched files are already concurrent with each other, one generator
// per path, combined by `combineDataSources` (see #582).
//
// Built as a Repeater rather than a plain `async function*`: once a value
// has been yielded, this generator suspends waiting for the *next*
// filesystem event, which may never happen. A native async generator
// queues an early `.return()` call behind that in-flight wait per the
// ECMAScript spec, hanging teardown forever. Repeater.return() instead
// settles immediately, which is what lets the race against `stop` below
// return without waiting on an event (see #339, and the markDataSource fix
// in #337 this mirrors).
export function watchDataFile(
  path: string,
  onHealth?: DataSourceHealthCallback,
): DataSource {
  return new Repeater(async (push, stop) => {
    const watcher = watch(path)
    // chokidar emits 'error' for issues like a removed watch directory; an
    // unhandled 'error' event on an EventEmitter throws, so a permanent
    // listener is required to keep the watcher (and this generator) alive.
    watcher.on('error', (err) => {
      log.warn('error watching data file', path, err)
    })
    try {
      let lastStreams: StreamDataContent[] = []
      while (true) {
        let streams: StreamDataContent[] = []
        try {
          const text = await fsPromises.readFile(path)
          const data = TOML.parse(text.toString())
          const parsed = parseStreamList(data?.streams)
          if (parsed.errors.length) {
            log.warn(
              `ignoring ${parsed.errors.length} invalid stream(s) in ${path}`,
            )
          }
          streams = parsed.streams as StreamDataContent[]
          onHealth?.(true)
        } catch (err) {
          log.warn('error reading data file', err)
          onHealth?.(false, err instanceof Error ? err.message : String(err))
        }

        // If the read/parse fails and we already have data, keep serving it
        // instead of wiping out every stream (mirrors pollDataURL).
        if (!streams.length && lastStreams.length) {
          log.warn('using cached stream data')
        } else {
          await push(streams)
          lastStreams = streams
        }

        // Wait for any filesystem event, not just 'change': an atomic
        // replace of the watched file can surface as unlink+add instead.
        // Raced against `stop` so an early return() settles immediately
        // instead of queuing behind an event that may never fire.
        const eventP = once(watcher, 'all')
        // Pure unhandled-rejection guard for the race loser. `once(watcher,
        // 'all')` rejects on a watcher 'error', which is already logged by the
        // persistent 'error' listener above -- so re-logging here would just
        // duplicate an already-surfaced breadcrumb (issue #392).
        eventP.catch(() => {})
        try {
          const result = await Promise.race([eventP, stop])
          if (result === undefined) {
            return
          }
        } catch {
          // A watcher 'error' rejected the race; the persistent 'error'
          // listener above is the single source of truth for logging it
          // (issue #464). Swallow it here and keep watching.
        }
      }
    } finally {
      await watcher.close()
    }
  })
}

/**
 * Emits a preset pack's entries once. Presets are static, bundled data -
 * there is nothing to poll or watch - so this pushes its one value and then
 * stays open, mirroring how `LocalStreamData.gen()` behaves after its
 * initial push.
 */
export function presetDataSource(
  pack: PresetPack,
): AsyncIterableIterator<StreamDataContent[]> {
  return new Repeater(async (push, stop) => {
    await push(pack.entries as StreamDataContent[])
    await stop
  })
}

// Built as a Repeater rather than a plain `async function*`: the combining
// layer (`latestPerSource`, previously `Repeater.latest`) always keeps one
// speculative `.next()` call in flight per source, which can be left
// permanently pending when a source has no further data. A native async generator queues `.return()`
// calls behind any in-flight `.next()` per the spec, so that dangling call
// would block teardown forever; Repeater.return() instead settles pending
// `.next()` calls immediately, which is what makes combineDataSources()'s
// early return work (see #264).
export function markDataSource(
  dataSource: DataSource,
  name: string,
): DataSource {
  return new Repeater(async (push, stop) => {
    try {
      while (true) {
        const nextP = dataSource.next()
        // Guard the race loser against an unhandled rejection, and log the
        // reason: a rejecting source (a failed watcher/generator) otherwise
        // propagates up through combineDataSources with no breadcrumb naming
        // which source stopped updating (issue #392). The rejection still
        // surfaces to the awaited race below, so error propagation is
        // unchanged.
        nextP.catch((err) => {
          log.warn('error advancing data source', name, err)
        })
        const iteration = await Promise.race([nextP, stop])
        if (iteration === undefined || iteration.done) {
          return iteration?.value
        }
        for (const s of iteration.value) {
          s._dataSource = name
        }
        await push(iteration.value)
      }
    } finally {
      await dataSource.return?.(undefined)
    }
  })
}

/** Name passed to `markDataSource` for the overlay (rotate-stream) source. */
export const OVERLAY_DATA_SOURCE_NAME = 'overlay'

// Combines the sources into a stream of "latest value per source" snapshots.
//
// This is deliberately *not* `Repeater.latest`: that combinator withholds
// every value until each contender has produced a first one, so a single slow
// or black-holed source (e.g. a `--data.json-url` pointing at a host that
// accepts the connection and never answers - `fetch` has no client-side
// timeout) keeps the entire wall empty for as long as it hangs, even though
// every other source has already delivered (issue #596).
//
// Here each source is advanced independently and a snapshot is emitted as soon
// as *any* source yields; sources that have not spoken yet contribute an empty
// batch and are filled in when they do. No value is dropped or duplicated: a
// snapshot is pushed per received batch, and each snapshot carries the latest
// batch of every source at push time. Slot order matches `dataSources` order,
// which is what gives later sources precedence in the merge below.
function latestPerSource(
  dataSources: DataSource[],
): Repeater<StreamDataContent[][]> {
  return new Repeater(async (push, stop) => {
    const latest: StreamDataContent[][] = dataSources.map(() => [])
    let stopped = false
    void stop.then(() => {
      stopped = true
    })
    try {
      await Promise.all(
        dataSources.map(async (dataSource, index) => {
          while (!stopped) {
            const nextP = dataSource.next()
            // Guard the race loser against an unhandled rejection. The
            // rejection still surfaces to the awaited race (and is logged,
            // named, by markDataSource), so error propagation is unchanged.
            nextP.catch(() => {})
            const iteration = await Promise.race([nextP, stop])
            if (stopped || iteration === undefined || iteration.done) {
              return
            }
            latest[index] = iteration.value
            // Raced against `stop` so a teardown while the consumer is not
            // pulling settles immediately instead of waiting for a pull that
            // will never come.
            const pushP = push([...latest])
            pushP.catch(() => {})
            await Promise.race([pushP, stop])
          }
        }),
      )
    } finally {
      // Repeater combinators do not propagate return() to their contenders, so
      // signal the sources explicitly - otherwise pollers and file watchers
      // keep running after the combined generator is done. Deliberately not
      // awaited: a source that is wedged inside its own executor (exactly the
      // hung-source case this combinator exists to survive) never settles its
      // return(), and waiting on it would re-introduce the hang here.
      for (const dataSource of dataSources) {
        void Promise.resolve(dataSource.return?.(undefined)).catch(
          (err: unknown) => {
            log.warn('error closing data source', err)
          },
        )
      }
    }
  })
}

export async function* combineDataSources(
  dataSources: DataSource[],
  idGen: StreamIDGenerator,
) {
  for await (const streamLists of latestPerSource(dataSources)) {
    const dataByURL = new Map<string, StreamData>()
    for (const list of streamLists) {
      for (const data of list) {
        const existing = dataByURL.get(data.link)
        if (data._dataSource === OVERLAY_DATA_SOURCE_NAME) {
          // Overlay entries only ever carry display-only patch fields (e.g.
          // rotation) applied via LocalStreamData.update(), which also fills
          // in a `kind` because StreamDataContent requires one - that value
          // is never meaningful and must not clobber the stream's real kind
          // (or its `_dataSource`, provenance). Drop the entry outright if
          // there's no real stream to patch, rather than fabricating one for
          // a URL no other source knows about.
          if (existing) {
            const { kind: _kind, _dataSource: _source, ...patch } = data
            dataByURL.set(data.link, { ...existing, ...patch } as StreamData)
          }
          continue
        }
        dataByURL.set(data.link, { ...existing, ...data } as StreamData)
      }
    }

    const streams = idGen.process([...dataByURL.values()]) as StreamList

    // Retain the index to speed up local lookups
    streams.byURL = dataByURL
    yield streams
  }
}

interface LocalStreamDataEvents {
  update: [StreamDataContent[]]
}

export class LocalStreamData extends EventEmitter<LocalStreamDataEvents> {
  dataByURL: Map<string, StreamDataContent>

  constructor(entries: StreamDataContent[] = []) {
    super()
    this.dataByURL = new Map()
    for (const entry of entries) {
      if (!entry.link) {
        continue
      }
      this.dataByURL.set(entry.link, entry)
    }
  }

  update(url: string, data: Partial<StreamDataContent>) {
    const existing = this.dataByURL.get(url)
    const kind = data.kind ?? existing?.kind ?? 'video'
    const updated: StreamDataContent = {
      ...existing,
      ...data,
      kind,
      link: data.link ?? url,
    }
    this.dataByURL.set(data.link ?? url, updated)
    if (data.link != null && url !== data.link) {
      this.dataByURL.delete(url)
    }
    this._emitUpdate()
  }

  delete(url: string) {
    this.dataByURL.delete(url)
    this._emitUpdate()
  }

  _emitUpdate() {
    this.emit('update', [...this.dataByURL.values()])
  }

  gen(): AsyncIterableIterator<StreamDataContent[]> {
    return new Repeater(async (push, stop) => {
      await push([...this.dataByURL.values()])
      this.on('update', push)
      await stop
      this.off('update', push)
    })
  }
}

export class StreamIDGenerator {
  idMap: Map<string, string>
  idSet: Set<string>

  constructor() {
    this.idMap = new Map()
    this.idSet = new Set()
  }

  process(streams: StreamDataContent[]) {
    const { idMap, idSet } = this

    for (const stream of streams) {
      const { link, source, label } = stream
      let streamId = idMap.get(link)
      if (streamId == null) {
        let counter = 0
        let newId
        const idBase = source || label || link
        if (!idBase) {
          log.warn('skipping empty stream', stream)
          continue
        }
        const normalizedText = idBase
          .toLowerCase()
          .replace(/[^\w]/g, '')
          .replace(/^the|^https?(www)?/, '')
        do {
          const textPart = normalizedText.substr(0, 3).toLowerCase()
          const counterPart = counter === 0 && textPart ? '' : counter
          newId = `${textPart}${counterPart}`
          counter++
        } while (idSet.has(newId))

        streamId = newId
        idMap.set(link, streamId)
        idSet.add(streamId)
      }

      stream._id = streamId
    }
    return streams
  }
}
