import { Repeater } from '@repeaterjs/repeater'
import { watch } from 'chokidar'
import { once } from 'events'
import { promises as fsPromises } from 'fs'
import { StreamDataContent } from '../../../../streamwall-shared/src/types'
import log from '../logger'
import { parseStreamFileContents } from './parse'
import type { DataSource, DataSourceHealthCallback } from './types'

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
          streams = parseStreamFileContents(text.toString(), path)
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
