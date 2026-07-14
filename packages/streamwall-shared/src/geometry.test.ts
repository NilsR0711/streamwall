import { describe, expect, it } from 'vitest'
import type { ViewContent } from './geometry.ts'
import {
  boxesFromViewContentMap,
  clampGridDimension,
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
