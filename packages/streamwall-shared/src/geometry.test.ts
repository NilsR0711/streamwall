import { describe, expect, it } from 'vitest'
import {
  clampGridDimension,
  GRID_MAX,
  GRID_MIN,
  idxToCoords,
  remapGridAssignments,
} from './geometry.ts'

describe('idxToCoords', () => {
  it('maps an index to grid coordinates', () => {
    expect(idxToCoords(3, 4)).toEqual({ x: 1, y: 1 })
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
