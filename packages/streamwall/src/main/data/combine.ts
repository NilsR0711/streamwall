import { Repeater } from '@repeaterjs/repeater'
import {
  StreamData,
  StreamDataContent,
  StreamList,
} from '../../../../streamwall-shared/src/types'
import log from '../logger'
import type { StreamIDGenerator } from './parse'
import type { DataSource } from './types'

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
