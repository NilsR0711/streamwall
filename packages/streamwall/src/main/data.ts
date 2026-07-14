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

const sleep = promisify(setTimeout)

type DataSource = AsyncIterableIterator<StreamDataContent[]>

export async function* pollDataURL(url: string, intervalSecs: number) {
  const refreshInterval = intervalSecs * 1000
  let lastData: StreamDataContent[] = []
  while (true) {
    let data: StreamDataContent[] = []
    try {
      const resp = await fetch(url)
      const { streams, errors } = parseStreamList(await resp.json())
      if (errors.length) {
        console.warn(`ignoring ${errors.length} invalid stream(s) from ${url}`)
      }
      data = streams as StreamDataContent[]
    } catch (err) {
      console.warn('error loading stream data', err)
    }

    // If the endpoint errors or returns an empty dataset, keep the cached data.
    if (!data.length && lastData.length) {
      console.warn('using cached stream data')
    } else {
      yield data
      lastData = data
    }

    await sleep(refreshInterval)
  }
}

export async function* watchDataFile(path: string): DataSource {
  const watcher = watch(path)
  // chokidar emits 'error' for issues like a removed watch directory; an
  // unhandled 'error' event on an EventEmitter throws, so a permanent
  // listener is required to keep the watcher (and this generator) alive.
  watcher.on('error', (err) => {
    console.warn('error watching data file', path, err)
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
          console.warn(
            `ignoring ${parsed.errors.length} invalid stream(s) in ${path}`,
          )
        }
        streams = parsed.streams as StreamDataContent[]
      } catch (err) {
        console.warn('error reading data file', err)
      }

      // If the read/parse fails and we already have data, keep serving it
      // instead of wiping out every stream (mirrors pollDataURL).
      if (!streams.length && lastStreams.length) {
        console.warn('using cached stream data')
      } else {
        yield streams
        lastStreams = streams
      }

      try {
        // Wait for any filesystem event, not just 'change': an atomic
        // replace of the watched file can surface as unlink+add instead.
        await once(watcher, 'all')
      } catch (err) {
        console.warn('error watching data file', path, err)
      }
    }
  } finally {
    await watcher.close()
  }
}

export async function* markDataSource(dataSource: DataSource, name: string) {
  for await (const streamList of dataSource) {
    for (const s of streamList) {
      s._dataSource = name
    }
    yield streamList
  }
}

export async function* combineDataSources(
  dataSources: DataSource[],
  idGen: StreamIDGenerator,
) {
  for await (const streamLists of Repeater.latest(dataSources)) {
    const dataByURL = new Map<string, StreamData>()
    for (const list of streamLists) {
      for (const data of list) {
        const existing = dataByURL.get(data.link)
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
    const updated: StreamDataContent = { ...existing, ...data, kind, link: url }
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
          console.warn('skipping empty stream', stream)
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
