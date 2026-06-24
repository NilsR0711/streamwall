import { describe, expect, it } from 'vitest'
import { idxToCoords } from './geometry.ts'

describe('idxToCoords', () => {
  it('maps an index to grid coordinates', () => {
    expect(idxToCoords(3, 4)).toEqual({ x: 1, y: 1 })
  })
})
