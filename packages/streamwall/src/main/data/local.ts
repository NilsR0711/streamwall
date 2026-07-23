import { Repeater } from '@repeaterjs/repeater'
import { EventEmitter } from 'events'
import { StreamDataContent } from '../../../../streamwall-shared/src/types'
import type { PresetPack } from '../presets'

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
