import TOML from '@iarna/toml'
import { Repeater } from '@repeaterjs/repeater'
import { watch } from 'chokidar'
import { EventEmitter, once } from 'events'
import { promises as fsPromises } from 'fs'
import fetch from 'node-fetch'
import { parseStreamList } from 'streamwall-shared'
import { promisify } from 'util'
import {
  StreamData,
  StreamDataContent,
  StreamList,
} from '../../../streamwall-shared/src/types'
import log from './logger'

const sleep = promisify(setTimeout)

type DataSource = AsyncIterableIterator<StreamDataContent[]>

// Reports whether the most recent read of a data source succeeded, so a
// caller can surface a dead json-url/toml-file from the UI instead of it
// only being diagnosable from a log.
export type DataSourceHealthCallback = (ok: boolean, message?: string) => void

export async function* pollDataURL(
  url: string,
  intervalSecs: number,
  onHealth?: DataSourceHealthCallback,
) {
  const refreshInterval = intervalSecs * 1000
  let lastData: StreamDataContent[] = []
  while (true) {
    let data: StreamDataContent[] = []
    try {
      const resp = await fetch(url)
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

export async function* watchDataFile(
  path: string,
  onHealth?: DataSourceHealthCallback,
): DataSource {
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
        yield streams
        lastStreams = streams
      }

      try {
        // Wait for any filesystem event, not just 'change': an atomic
        // replace of the watched file can surface as unlink+add instead.
        await once(watcher, 'all')
      } catch (err) {
        log.warn('error watching data file', path, err)
      }
    }
  } finally {
    await watcher.close()
  }
}

// Built as a Repeater rather than a plain `async function*`: Repeater.latest()
// (used by combineDataSources) always keeps one speculative `.next()` call
// in flight per contender, which can be left permanently pending when a
// source has no further data. A native async generator queues `.return()`
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
        nextP.catch(() => {})
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

export async function* combineDataSources(
  dataSources: DataSource[],
  idGen: StreamIDGenerator,
) {
  for await (const streamLists of Repeater.latest(dataSources)) {
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
