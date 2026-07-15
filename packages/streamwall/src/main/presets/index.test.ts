import { describe, expect, test } from 'vitest'
import { buildPresetPack, loadPresetPack } from './index'

describe('buildPresetPack', () => {
  test('keeps valid entries and drops invalid ones', () => {
    const pack = buildPresetPack('test-pack', 'Test Pack', [
      { link: 'https://a.example/s', kind: 'video', label: 'A' },
      { kind: 'video' }, // missing link - dropped
      { link: 'https://b.example/s', kind: 'video', label: 'B' },
    ])

    expect(pack).toEqual({
      id: 'test-pack',
      name: 'Test Pack',
      entries: [
        { link: 'https://a.example/s', kind: 'video', label: 'A' },
        { link: 'https://b.example/s', kind: 'video', label: 'B' },
      ],
    })
  })

  test('produces an empty entries list when every input entry is invalid', () => {
    const pack = buildPresetPack('test-pack', 'Test Pack', [{ kind: 'video' }])
    expect(pack.entries).toEqual([])
  })

  test('produces an empty entries list for non-array input', () => {
    const pack = buildPresetPack('test-pack', 'Test Pack', 'not an array')
    expect(pack.entries).toEqual([])
  })
})

describe('loadPresetPack', () => {
  test('returns the bundled German free-TV pack with every entry a valid https video stream', () => {
    const pack = loadPresetPack('de-tv')

    expect(pack).toBeDefined()
    expect(pack?.id).toBe('de-tv')
    expect(pack?.name).toBe('German Free-TV')
    expect(pack?.entries.length).toBeGreaterThanOrEqual(19)
    for (const entry of pack?.entries ?? []) {
      expect(entry.link.startsWith('https://')).toBe(true)
      expect(entry.kind).toBe('video')
      expect(entry.label).toBeTruthy()
    }
  })

  test('every bundled de-tv entry has a unique link', () => {
    const pack = loadPresetPack('de-tv')
    const links = pack?.entries.map((e) => e.link) ?? []
    expect(new Set(links).size).toBe(links.length)
  })

  test('returns undefined for an unknown pack id', () => {
    expect(loadPresetPack('not-a-real-pack')).toBeUndefined()
  })
})
