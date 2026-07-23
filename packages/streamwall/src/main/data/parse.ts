import TOML from '@iarna/toml'
import { parseStreamList } from 'streamwall-shared'
import { StreamDataContent } from '../../../../streamwall-shared/src/types'
import log from '../logger'

// Shared by the URL poller and the file watcher: keep the entries
// parseStreamList accepts and warn about the rejected ones instead of
// failing the whole batch. `origin` names where the payload came from,
// e.g. "from <url>" or "in <path>", and only shapes the warning.
export function parseStreamEntries(
  raw: unknown,
  origin: string,
): StreamDataContent[] {
  const { streams, errors } = parseStreamList(raw)
  if (errors.length) {
    log.warn(`ignoring ${errors.length} invalid stream(s) ${origin}`)
  }
  return streams as StreamDataContent[]
}

/** Parses a watched TOML file's text into validated stream entries. */
export function parseStreamFileContents(
  text: string,
  path: string,
): StreamDataContent[] {
  const data = TOML.parse(text)
  return parseStreamEntries(data?.streams, `in ${path}`)
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
