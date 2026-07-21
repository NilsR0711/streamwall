import { describe, expect, test } from 'vitest'
import {
  asCellIdx,
  asCellIdxs,
  asViewId,
  type CellIdx,
  type ViewId,
} from './viewAddressing.ts'

describe('viewAddressing', () => {
  test('tagging is a compile-time-only operation', () => {
    expect(asViewId(7)).toBe(7)
    expect(asCellIdx(0)).toBe(0)
    expect(asCellIdxs([0, 3])).toEqual([0, 3])
  })

  // The guards below are the actual point of this module: they fail the
  // typecheck — not the test run — if the two axes ever become interchangeable
  // again, which is how a cell index reached a view-id command in #470. An
  // `@ts-expect-error` that stops erroring is itself a compile error, so an
  // accidental widening of either brand breaks CI.
  test('a cell index is not accepted where a view id is expected', () => {
    function takesViewId(viewId: ViewId) {
      return viewId
    }
    const cellIdx = asCellIdx(3)

    // @ts-expect-error a grid cell index is not a stable view id
    takesViewId(cellIdx)
    // @ts-expect-error an untagged number is not a stable view id either
    takesViewId(3)

    expect(takesViewId(asViewId(3))).toBe(3)
  })

  test('a view id is not accepted where a cell index is expected', () => {
    function takesCellIdx(idx: CellIdx) {
      return idx
    }
    const viewId = asViewId(3)

    // @ts-expect-error a view id does not address a grid cell
    takesCellIdx(viewId)
    // @ts-expect-error an untagged number does not address a grid cell either
    takesCellIdx(3)

    expect(takesCellIdx(asCellIdx(3))).toBe(3)
  })

  test('both axes stay usable as plain numbers in grid arithmetic', () => {
    function takesNumber(value: number) {
      return value
    }

    expect(takesNumber(asCellIdx(2))).toBe(2)
    expect(takesNumber(asViewId(2))).toBe(2)
  })
})
