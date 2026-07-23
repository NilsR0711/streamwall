import { describe, expect, test, vi } from 'vitest'
import type { PresetPack } from '../presets'
import { combineDataSources, markDataSource } from './combine'
import { LocalStreamData, presetDataSource } from './local'
import { StreamIDGenerator } from './parse'
import { waitForListener } from './testHelpers'

describe('LocalStreamData', () => {
  test('indexes entries by link and drops entries without a link', () => {
    const data = new LocalStreamData([
      { kind: 'video', link: 'https://a.example/s' },
      { kind: 'video', link: '' },
    ])
    expect([...data.dataByURL.keys()]).toEqual(['https://a.example/s'])
  })

  test('update() defaults kind to "video" for a brand new entry', () => {
    const data = new LocalStreamData()
    data.update('https://a.example/s', {})
    expect(data.dataByURL.get('https://a.example/s')).toMatchObject({
      kind: 'video',
      link: 'https://a.example/s',
    })
  })

  test('update() preserves the existing kind when not overridden', () => {
    const data = new LocalStreamData([
      { kind: 'audio', link: 'https://a.example/s' },
    ])
    data.update('https://a.example/s', { label: 'Renamed' })
    expect(data.dataByURL.get('https://a.example/s')).toMatchObject({
      kind: 'audio',
      label: 'Renamed',
    })
  })

  // Only the Map key move is asserted here: the stored entry's own `.link`
  // field is left stale (the old url) after a rekey, tracked as a separate
  // bug in issue #274.
  test('update() rekeys the entry when data.link differs from the lookup url', () => {
    const data = new LocalStreamData([
      { kind: 'video', link: 'https://a.example/s' },
    ])
    data.update('https://a.example/s', { link: 'https://b.example/s' })
    expect(data.dataByURL.has('https://a.example/s')).toBe(false)
    expect(data.dataByURL.has('https://b.example/s')).toBe(true)
  })

  test('update() stores the new link on the entry itself after rekeying', () => {
    const data = new LocalStreamData([
      { kind: 'video', link: 'https://a.example/s' },
    ])
    data.update('https://a.example/s', { link: 'https://b.example/s' })
    expect(data.dataByURL.get('https://b.example/s')?.link).toBe(
      'https://b.example/s',
    )
  })

  test('update() emits the full entry list on the "update" event', () => {
    const data = new LocalStreamData()
    const onUpdate = vi.fn()
    data.on('update', onUpdate)
    data.update('https://a.example/s', { kind: 'video' })
    expect(onUpdate).toHaveBeenCalledWith([
      expect.objectContaining({ link: 'https://a.example/s' }),
    ])
  })

  test('delete() removes the entry and emits the update event', () => {
    const data = new LocalStreamData([
      { kind: 'video', link: 'https://a.example/s' },
    ])
    const onUpdate = vi.fn()
    data.on('update', onUpdate)
    data.delete('https://a.example/s')
    expect(data.dataByURL.has('https://a.example/s')).toBe(false)
    expect(onUpdate).toHaveBeenCalledWith([])
  })

  test('gen() yields the current snapshot immediately and again after an update', async () => {
    const data = new LocalStreamData([
      { kind: 'video', link: 'https://a.example/s' },
    ])
    const iterator = data.gen()
    try {
      const first = await iterator.next()
      expect(first.value?.map((s) => s.link)).toEqual(['https://a.example/s'])

      // Starting the next pull is what lets the generator's buffered push()
      // resolve and reach the `this.on('update', push)` line (the Repeater's
      // zero-capacity buffer only frees up once a subsequent pull begins).
      const pending = iterator.next()
      await waitForListener(data, 'update')
      data.update('https://b.example/s', { kind: 'video' })
      const second = await pending
      expect(second.value?.map((s) => s.link)).toEqual([
        'https://a.example/s',
        'https://b.example/s',
      ])
    } finally {
      await iterator.return?.(undefined)
    }
  })
})

describe('presetDataSource', () => {
  test('yields the pack entries once and stays open', async () => {
    const pack: PresetPack = {
      id: 'test-pack',
      name: 'Test Pack',
      entries: [{ link: 'https://a.example/s', kind: 'video', label: 'A' }],
    }
    const gen = presetDataSource(pack)
    try {
      const { value } = await gen.next()
      expect(value).toEqual([
        { link: 'https://a.example/s', kind: 'video', label: 'A' },
      ])
    } finally {
      await gen.return?.(undefined)
    }
  })

  test('combines with other sources via combineDataSources, tagged with the given source name', async () => {
    const pack: PresetPack = {
      id: 'de-tv',
      name: 'German Free-TV',
      entries: [{ link: 'https://ard.example/s', kind: 'video', label: 'ARD' }],
    }
    const idGen = new StreamIDGenerator()
    const iterator = combineDataSources(
      [markDataSource(presetDataSource(pack), 'preset:de-tv')],
      idGen,
    )
    try {
      const { value } = await iterator.next()
      expect(value).toHaveLength(1)
      expect(value?.[0]).toMatchObject({
        link: 'https://ard.example/s',
        _dataSource: 'preset:de-tv',
      })
    } finally {
      await iterator.return?.(undefined)
    }
  })
})
