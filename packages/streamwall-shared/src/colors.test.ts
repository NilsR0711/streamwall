import { describe, expect, it } from 'vitest'
import { Color, hashText, idColor } from './colors.ts'

describe('hashText', () => {
  it('returns a fixed hash for a fixed input', () => {
    expect(hashText('streamwall', 360)).toBe(292)
    expect(hashText('streamwall', 40)).toBe(28)
  })

  it('is deterministic across repeated calls', () => {
    expect(hashText('example-id', 360)).toBe(hashText('example-id', 360))
    expect(hashText('example-id', 40)).toBe(hashText('example-id', 40))
  })

  it('returns 0 for an empty string', () => {
    expect(hashText('', 360)).toBe(0)
  })

  it('stays within [0, range) for short ids', () => {
    for (const range of [360, 40]) {
      for (const id of ['a', 'ab', 'abc']) {
        const hash = hashText(id, range)
        expect(hash).toBeGreaterThanOrEqual(0)
        expect(hash).toBeLessThan(range)
      }
    }
  })

  // Longer or higher-charCode inputs previously overflowed the 32-bit
  // accumulator (`val << 5`), producing hashes outside [0, range) — e.g.
  // hashText('streamwall', 40) used to return -12.
  it('stays within [0, range) for ids that previously overflowed', () => {
    const ids = [
      'stream1',
      'streamwall',
      'dQw4w9WgXcQ',
      'UCabcdefghij1234567890',
      'https://twitch.tv/somechannel',
      'x'.repeat(100),
    ]
    for (const range of [360, 40]) {
      for (const id of ids) {
        const hash = hashText(id, range)
        expect(hash).toBeGreaterThanOrEqual(0)
        expect(hash).toBeLessThan(range)
      }
    }
  })
})

describe('idColor', () => {
  it('returns white for an empty id', () => {
    const color = idColor('')
    expect(color.hex()).toBe('#FFFFFF')
    expect(color.hsl().object()).toEqual({ h: 0, s: 0, l: 100 })
  })

  it('returns a fixed color for a fixed id', () => {
    const color = idColor('streamwall')
    expect(color.hex()).toBe('#AC42BD')
    expect(color.hsl().object()).toEqual({ h: 292, s: 48, l: 50 })
  })

  it('is deterministic for the same id', () => {
    expect(idColor('stream-1').hex()).toBe(idColor('stream-1').hex())
  })

  it('produces different colors for different ids', () => {
    expect(idColor('a').hex()).not.toBe(idColor('b').hex())
  })

  it('keeps hue and saturation within their expected bounds for ids that previously overflowed', () => {
    const ids = ['dQw4w9WgXcQ', 'https://twitch.tv/somechannel', 'streamwall']
    for (const id of ids) {
      const { h, s, l } = idColor(id).hsl().object()
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThan(360)
      expect(s).toBeGreaterThanOrEqual(20)
      expect(s).toBeLessThan(60)
      expect(l).toBe(50)
    }
  })

  // Consumers in other workspaces (e.g. streamwall-control-ui) re-wrap this
  // value with `Color(...)` themselves. That only works if they construct
  // their own `Color` from this same re-exported constructor rather than
  // importing the `color` package directly — otherwise the two modules are
  // physically different copies (see the monorepo's per-workspace
  // node_modules layout in package-lock.json), and `Color`'s `instanceof`
  // fast path fails, throwing "Unable to parse color from object".
  it('returns an instance recognized by the re-exported Color constructor', () => {
    expect(idColor('streamwall')).toBeInstanceOf(Color)
  })
})
