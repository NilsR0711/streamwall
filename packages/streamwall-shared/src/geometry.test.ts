import { describe, expect, it } from 'vitest'
import type { ViewContent } from './geometry.ts'
import {
  boxesFromViewContentMap,
  clampGridDimension,
  computeBoxRect,
  fullscreenViewContentMap,
  GRID_MAX,
  GRID_MIN,
  gridWouldDropAssignments,
  hasGridAssignments,
  idxToCoords,
  parseGridDimensionInput,
  remapGridAssignments,
} from './geometry.ts'

describe('idxToCoords', () => {
  it('maps an index to grid coordinates', () => {
    expect(idxToCoords(3, 4)).toEqual({ x: 1, y: 1 })
  })
})

describe('boxesFromViewContentMap', () => {
  it('sorts a box spaces numerically so spaces[0] stays the top-left cell', () => {
    // 8 cols: a box spanning (x=2,y=0) and (x=2,y=1) covers indices 2 and 10.
    // A lexicographic sort would order these as ["10", "2"] -> [10, 2],
    // making spaces[0] (used as the box's "top-left" index) wrong.
    const content: ViewContent = { url: 'https://example.com', kind: 'video' }
    const viewContentMap = new Map([
      ['2', content],
      ['10', content],
    ])

    const boxes = boxesFromViewContentMap(8, 8, viewContentMap)

    expect(boxes).toHaveLength(1)
    expect(boxes[0].spaces).toEqual([2, 10])
  })

  it('returns no boxes for an empty content map', () => {
    expect(boxesFromViewContentMap(3, 3, new Map())).toEqual([])
  })

  it('boxes a single occupied cell', () => {
    // 3x3 grid, content only at (x=1,y=1) = idx 4.
    const content: ViewContent = { url: 'https://example.com', kind: 'video' }
    const viewContentMap = new Map([['4', content]])

    const boxes = boxesFromViewContentMap(3, 3, viewContentMap)

    expect(boxes).toEqual([{ content, x: 1, y: 1, w: 1, h: 1, spaces: [4] }])
  })

  it('merges a full row of identical content into one box', () => {
    // 3x2 grid, row y=0 (indices 0,1,2) all share the same content.
    const content: ViewContent = { url: 'https://example.com', kind: 'video' }
    const viewContentMap = new Map([
      ['0', content],
      ['1', content],
      ['2', content],
    ])

    const boxes = boxesFromViewContentMap(3, 2, viewContentMap)

    expect(boxes).toEqual([
      { content, x: 0, y: 0, w: 3, h: 1, spaces: [0, 1, 2] },
    ])
  })

  it('merges a 2x2 block of identical content into one box', () => {
    // 3x3 grid, indices 0,1,3,4 form a 2x2 block at (x=0,y=0).
    const content: ViewContent = { url: 'https://example.com', kind: 'video' }
    const viewContentMap = new Map([
      ['0', content],
      ['1', content],
      ['3', content],
      ['4', content],
    ])

    const boxes = boxesFromViewContentMap(3, 3, viewContentMap)

    expect(boxes).toEqual([
      { content, x: 0, y: 0, w: 2, h: 2, spaces: [0, 1, 3, 4] },
    ])
  })

  it('splits L-shaped content into two rectangular boxes', () => {
    // 3x2 grid: content at (0,0)=0, (1,0)=1, (0,1)=3, but NOT (1,1)=4 -
    // an L-shape that no single rectangle can cover.
    const content: ViewContent = { url: 'https://example.com', kind: 'video' }
    const viewContentMap = new Map([
      ['0', content],
      ['1', content],
      ['3', content],
    ])

    const boxes = boxesFromViewContentMap(3, 2, viewContentMap)

    expect(boxes).toEqual([
      { content, x: 0, y: 0, w: 1, h: 2, spaces: [0, 3] },
      { content, x: 1, y: 0, w: 1, h: 1, spaces: [1] },
    ])
  })

  it('keeps identical content in non-adjacent cells as separate boxes', () => {
    // 3x3 grid: the same content at opposite corners (0,0) and (2,2) has no
    // shared edge, so it cannot merge into a single rectangle.
    const content: ViewContent = { url: 'https://example.com', kind: 'video' }
    const viewContentMap = new Map([
      ['0', content],
      ['8', content],
    ])

    const boxes = boxesFromViewContentMap(3, 3, viewContentMap)

    expect(boxes).toEqual([
      { content, x: 0, y: 0, w: 1, h: 1, spaces: [0] },
      { content, x: 2, y: 2, w: 1, h: 1, spaces: [8] },
    ])
  })

  it('does not merge adjacent cells with the same url but a different kind', () => {
    // 2x1 grid: idx0 and idx1 share a url but differ in kind, so they are
    // distinct ViewContent values and must not be merged.
    const videoContent: ViewContent = {
      url: 'https://example.com',
      kind: 'video',
    }
    const webContent: ViewContent = {
      url: 'https://example.com',
      kind: 'web',
    }
    const viewContentMap = new Map([
      ['0', videoContent],
      ['1', webContent],
    ])

    const boxes = boxesFromViewContentMap(2, 1, viewContentMap)

    expect(boxes).toEqual([
      { content: videoContent, x: 0, y: 0, w: 1, h: 1, spaces: [0] },
      { content: webContent, x: 1, y: 0, w: 1, h: 1, spaces: [1] },
    ])
  })
})

describe('computeBoxRect', () => {
  it('gives an interior box the plain floor-divided space size', () => {
    // 1000 / 7 = 142.86 -> floors to 142 per cell.
    const rect = computeBoxRect(7, 7, 1000, 1000, { x: 0, y: 0, w: 1, h: 1 })
    expect(rect).toEqual({ x: 0, y: 0, width: 142, height: 142 })
  })

  it('extends the last column to the right edge, absorbing the residual pixels', () => {
    // spaceWidth=142, 7*142=994, so column 6 would normally stop 6px short.
    const rect = computeBoxRect(7, 7, 1000, 1000, { x: 6, y: 0, w: 1, h: 1 })
    expect(rect.x).toBe(852) // 142 * 6
    expect(rect.width).toBe(148) // 1000 - 852, not 142
  })

  it('extends the last row to the bottom edge, absorbing the residual pixels', () => {
    const rect = computeBoxRect(7, 7, 1000, 1000, { x: 0, y: 6, w: 1, h: 1 })
    expect(rect.y).toBe(852) // 142 * 6
    expect(rect.height).toBe(148) // 1000 - 852, not 142
  })

  it('gives a multi-cell box that reaches the edge the full residual width', () => {
    // Box spans x=5..6 (w=2), reaching the right edge at cols=7.
    const rect = computeBoxRect(7, 7, 1000, 1000, { x: 5, y: 0, w: 2, h: 1 })
    expect(rect.x).toBe(710) // 142 * 5
    expect(rect.width).toBe(290) // 1000 - 710, not 142 * 2 (284)
  })

  it('does not extend a box that does not reach the last column/row', () => {
    const rect = computeBoxRect(7, 7, 1000, 1000, { x: 0, y: 0, w: 2, h: 2 })
    expect(rect).toEqual({ x: 0, y: 0, width: 284, height: 284 })
  })

  it('leaves exact divisions untouched', () => {
    // 8 cols into 1920px divides evenly (240 per cell).
    const rect = computeBoxRect(8, 8, 1920, 1080, { x: 7, y: 0, w: 1, h: 1 })
    expect(rect).toEqual({ x: 1680, y: 0, width: 240, height: 135 })
  })
})

describe('clampGridDimension', () => {
  it('clamps below the minimum', () => {
    expect(clampGridDimension(0)).toBe(GRID_MIN)
  })
  it('clamps above the maximum', () => {
    expect(clampGridDimension(99)).toBe(GRID_MAX)
  })
  it('rounds and passes through valid values', () => {
    expect(clampGridDimension(3.4)).toBe(3)
  })
  it('falls back to the minimum for non-finite input', () => {
    expect(clampGridDimension(Number.NaN)).toBe(GRID_MIN)
  })
})

describe('remapGridAssignments', () => {
  it('keeps assignments at the same (x,y) when adding columns', () => {
    // 2x2: idx0='a' at (0,0), idx3='b' at (1,1)
    const old = new Map<number, string | undefined>([
      [0, 'a'],
      [1, undefined],
      [2, undefined],
      [3, 'b'],
    ])
    const result = remapGridAssignments(2, 3, 2, old)
    // 3 cols: (0,0)->0, (1,1)->4
    expect(result.get(0)).toBe('a')
    expect(result.get(4)).toBe('b')
  })

  it('drops assignments outside a shrunk grid', () => {
    // 3x3: 'a' at (2,2)=idx8, 'b' at (0,0)=idx0
    const old = new Map<number, string | undefined>([
      [8, 'a'],
      [0, 'b'],
    ])
    const result = remapGridAssignments(3, 2, 2, old)
    expect([...result.values()].filter((v) => v === 'a')).toHaveLength(0)
    expect(result.get(0)).toBe('b')
  })

  it('returns a full new grid with empty new cells', () => {
    const old = new Map<number, string | undefined>([[0, 'a']])
    const result = remapGridAssignments(1, 2, 2, old)
    expect(result.size).toBe(4)
    expect(result.get(0)).toBe('a')
    expect(result.get(1)).toBeUndefined()
    expect(result.get(3)).toBeUndefined()
  })

  it('treats empty-string assignments as empty', () => {
    const old = new Map<number, string | undefined>([
      [0, ''],
      [1, 'a'],
    ])
    const result = remapGridAssignments(2, 2, 1, old)
    expect(result.get(0)).toBeUndefined()
    expect(result.get(1)).toBe('a')
  })

  it('ignores a stale entry beyond the true old grid when oldRows is given (issue #17)', () => {
    // The true old grid was only 3x1 (3 cells). Index 17 is a leftover key from
    // some previous, larger grid config that was never pruned. Naively reading
    // it via oldCols=3 alone gives (x=17%3=2, y=floor(17/3)=5), which lands
    // inside a large-enough new grid and would revive as a ghost stream.
    const old = new Map<number, string | undefined>([
      [0, 'a'],
      [17, 'ghost'],
    ])
    const result = remapGridAssignments(3, 6, 6, old, 1)
    expect([...result.values()]).not.toContain('ghost')
    expect(result.get(0)).toBe('a')
  })

  it('keeps an entry within the true old grid when oldRows is given', () => {
    // 3x2 grid: idx3 = (x=0, y=1).
    const old = new Map<number, string | undefined>([[3, 'b']])
    const result = remapGridAssignments(3, 4, 4, old, 2)
    expect(result.get(4)).toBe('b') // (0,1) -> 4*1 + 0 = 4
  })

  it('applies no extra filtering when oldRows is omitted (back-compat)', () => {
    const old = new Map<number, string | undefined>([[17, 'ghost']])
    const result = remapGridAssignments(3, 6, 6, old)
    expect(result.get(32)).toBe('ghost') // (x=2, y=5) -> 6*5 + 2 = 32
  })
})

describe('parseGridDimensionInput', () => {
  it('parses a valid in-range integer', () => {
    expect(parseGridDimensionInput('6')).toBe(6)
  })
  it('accepts the inclusive bounds', () => {
    expect(parseGridDimensionInput(String(GRID_MIN))).toBe(GRID_MIN)
    expect(parseGridDimensionInput(String(GRID_MAX))).toBe(GRID_MAX)
  })
  it('ignores an empty or whitespace-only field', () => {
    expect(parseGridDimensionInput('')).toBeNull()
    expect(parseGridDimensionInput('   ')).toBeNull()
  })
  it('ignores non-numeric and NaN input', () => {
    expect(parseGridDimensionInput('abc')).toBeNull()
    expect(parseGridDimensionInput('NaN')).toBeNull()
  })
  it('ignores values below the minimum', () => {
    expect(parseGridDimensionInput(String(GRID_MIN - 1))).toBeNull()
  })
  it('ignores values above the maximum', () => {
    expect(parseGridDimensionInput(String(GRID_MAX + 1))).toBeNull()
  })
  it('rounds fractional input that lands in range', () => {
    expect(parseGridDimensionInput('3.4')).toBe(3)
  })
})

describe('gridWouldDropAssignments', () => {
  it('returns true when a non-empty cell falls outside the shrunk grid', () => {
    // 4x4: 'a' at (3,3)=idx15 is dropped when shrinking to 2x2
    const assignments = new Map<number, string | undefined>([[15, 'a']])
    expect(gridWouldDropAssignments(4, 2, 2, assignments)).toBe(true)
  })
  it('returns false when every non-empty cell survives', () => {
    // 4x4: 'a' at (0,0)=idx0 survives a shrink to 2x2
    const assignments = new Map<number, string | undefined>([[0, 'a']])
    expect(gridWouldDropAssignments(4, 2, 2, assignments)).toBe(false)
  })
  it('ignores empty and empty-string cells that would be dropped', () => {
    const assignments = new Map<number, string | undefined>([
      [15, ''],
      [14, undefined],
    ])
    expect(gridWouldDropAssignments(4, 2, 2, assignments)).toBe(false)
  })
  it('returns false when the grid grows', () => {
    const assignments = new Map<number, string | undefined>([[3, 'a']])
    expect(gridWouldDropAssignments(2, 4, 4, assignments)).toBe(false)
  })
})

describe('hasGridAssignments', () => {
  it('returns false for an empty map', () => {
    expect(hasGridAssignments(new Map())).toBe(false)
  })
  it('returns false when every cell is empty or empty-string', () => {
    const assignments = new Map<number, string | undefined>([
      [0, undefined],
      [1, ''],
    ])
    expect(hasGridAssignments(assignments)).toBe(false)
  })
  it('returns true when at least one cell holds a streamId', () => {
    const assignments = new Map<number, string | undefined>([
      [0, undefined],
      [1, 'a'],
    ])
    expect(hasGridAssignments(assignments)).toBe(true)
  })
})

describe('fullscreenViewContentMap', () => {
  const content: ViewContent = { url: 'https://example.com', kind: 'video' }

  it('fills every cell of the grid with the given content', () => {
    const map = fullscreenViewContentMap(3, 2, content)
    expect(map.size).toBe(6)
    for (let idx = 0; idx < 6; idx++) {
      expect(map.get(String(idx))).toEqual(content)
    }
  })

  it('collapses into a single box spanning the whole grid', () => {
    const map = fullscreenViewContentMap(4, 3, content)
    const boxes = boxesFromViewContentMap(4, 3, map)
    expect(boxes).toHaveLength(1)
    expect(boxes[0].spaces).toEqual([...Array(12).keys()])
    expect(boxes[0]).toMatchObject({ x: 0, y: 0, w: 4, h: 3 })
  })

  it('produces a single full-screen box even on a 1×1 grid', () => {
    const boxes = boxesFromViewContentMap(
      1,
      1,
      fullscreenViewContentMap(1, 1, content),
    )
    expect(boxes).toHaveLength(1)
    expect(boxes[0].spaces).toEqual([0])
  })
})
