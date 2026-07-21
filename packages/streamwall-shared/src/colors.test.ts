import { describe, expect, it } from 'vitest'
import { Color, focusRingColors, hashText, idColor } from './colors.ts'

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

// The grid draws the shared `:focus-visible` ring with `outline-offset`, so
// the ring lands on the *neighbouring* tiles rather than on a neutral surface.
// A tile's colour comes from its stream id, so the accent token cannot
// guarantee the 3:1 WCAG 2.4.11 asks for — a red-ish tile leaves the red
// accent at roughly 2:1 (#557).
describe('focusRingColors', () => {
  it('picks the black/white pair with the better contrast against the tile', () => {
    expect(focusRingColors(Color('white'))).toEqual({
      ring: '#000000',
      halo: '#FFFFFF',
    })
    expect(focusRingColors(Color('black'))).toEqual({
      ring: '#FFFFFF',
      halo: '#000000',
    })
  })

  it('keeps the ring and halo contrasting against each other', () => {
    const { ring, halo } = focusRingColors(idColor('streamwall'))
    expect(Color(ring).contrast(Color(halo))).toBe(21)
  })

  it('clears 3:1 against the tile for every colour the id space can produce', () => {
    const ids = [
      '',
      'a',
      'stream-1',
      'streamwall',
      'dQw4w9WgXcQ',
      'https://twitch.tv/somechannel',
      ...Array.from({ length: 64 }, (_, i) => `id-${i}`),
    ]
    for (const id of ids) {
      // The grid paints tiles at lightness 75, or 90 while highlighted.
      for (const lightness of [75, 90]) {
        const tile = idColor(id).lightness(lightness)
        const { ring } = focusRingColors(tile)
        expect(tile.contrast(Color(ring))).toBeGreaterThanOrEqual(3)
      }
    }
  })
})
