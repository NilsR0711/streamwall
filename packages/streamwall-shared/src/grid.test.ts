import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  DEFAULT_GRID_COUNT,
  type GridDimensionsInput,
  MAX_GRID_DIMENSION,
  resolveGridDimensions,
} from './grid.ts'

describe('resolveGridDimensions', () => {
  test('defaults to a square grid of DEFAULT_GRID_COUNT when nothing is set', () => {
    assert.deepEqual(resolveGridDimensions({}), {
      cols: DEFAULT_GRID_COUNT,
      rows: DEFAULT_GRID_COUNT,
    })
  })

  test('count produces a square grid', () => {
    assert.deepEqual(resolveGridDimensions({ count: 4 }), { cols: 4, rows: 4 })
    assert.deepEqual(resolveGridDimensions({ count: 8 }), { cols: 8, rows: 8 })
  })

  test('supports a minimal 1x1 grid', () => {
    assert.deepEqual(resolveGridDimensions({ count: 1 }), { cols: 1, rows: 1 })
  })

  test('explicit cols and rows produce a non-square grid', () => {
    assert.deepEqual(resolveGridDimensions({ cols: 4, rows: 2 }), {
      cols: 4,
      rows: 2,
    })
  })

  test('explicit cols overrides count while rows falls back to count', () => {
    assert.deepEqual(resolveGridDimensions({ count: 4, cols: 6 }), {
      cols: 6,
      rows: 4,
    })
  })

  test('explicit rows overrides count while cols falls back to count', () => {
    assert.deepEqual(resolveGridDimensions({ count: 4, rows: 2 }), {
      cols: 4,
      rows: 2,
    })
  })

  test('a single explicit dimension falls back to the default for the other', () => {
    assert.deepEqual(resolveGridDimensions({ cols: 5 }), {
      cols: 5,
      rows: DEFAULT_GRID_COUNT,
    })
    assert.deepEqual(resolveGridDimensions({ rows: 5 }), {
      cols: DEFAULT_GRID_COUNT,
      rows: 5,
    })
  })

  test('supports the maximum allowed dimension', () => {
    assert.deepEqual(resolveGridDimensions({ count: MAX_GRID_DIMENSION }), {
      cols: MAX_GRID_DIMENSION,
      rows: MAX_GRID_DIMENSION,
    })
  })

  describe('validation', () => {
    const invalidCases: Array<[string, GridDimensionsInput]> = [
      ['count of zero', { count: 0 }],
      ['negative count', { count: -1 }],
      ['zero cols', { cols: 0 }],
      ['negative rows', { rows: -3 }],
      ['non-integer cols', { cols: 2.5 }],
      ['non-integer rows', { rows: 3.1 }],
      ['NaN count', { count: NaN }],
      ['Infinity cols', { cols: Infinity }],
      ['cols above maximum', { cols: MAX_GRID_DIMENSION + 1 }],
      ['rows above maximum', { rows: MAX_GRID_DIMENSION + 1 }],
    ]
    for (const [label, input] of invalidCases) {
      test(`throws for ${label}`, () => {
        assert.throws(() => resolveGridDimensions(input))
      })
    }

    test('error message names the offending dimension and its value', () => {
      assert.throws(() => resolveGridDimensions({ cols: 0 }), /cols/)
      assert.throws(() => resolveGridDimensions({ rows: -2 }), /rows/)
    })
  })
})
