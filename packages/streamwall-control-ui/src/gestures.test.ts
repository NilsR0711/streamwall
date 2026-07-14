import { describe, expect, it } from 'vitest'

import {
  computeHoveringIdx,
  DRAG_THRESHOLD_PX,
  isPrimaryButton,
  resolveMoveTarget,
} from './gestures'

describe('isPrimaryButton', () => {
  it('accepts the primary (left) button', () => {
    expect(isPrimaryButton(0)).toBe(true)
  })

  it('rejects secondary/middle/other buttons', () => {
    expect(isPrimaryButton(1)).toBe(false)
    expect(isPrimaryButton(2)).toBe(false)
    expect(isPrimaryButton(-1)).toBe(false)
  })
})

describe('resolveMoveTarget', () => {
  const moveStart = { idx: 3, x: 100, y: 100 }

  it('returns undefined when there is no active move', () => {
    expect(resolveMoveTarget(undefined, 5, 200, 200)).toBeUndefined()
  })

  it('returns undefined when released off the grid (no hover cell)', () => {
    // Regression: releasing off-grid must not commit against the last
    // in-grid cell that was hovered.
    expect(resolveMoveTarget(moveStart, undefined, 500, 500)).toBeUndefined()
  })

  it('returns undefined when the pointer has not moved past the threshold', () => {
    expect(
      resolveMoveTarget(moveStart, 8, moveStart.x + 2, moveStart.y + 2),
    ).toBeUndefined()
  })

  it('treats exactly the threshold distance as not-yet-a-drag', () => {
    expect(
      resolveMoveTarget(
        moveStart,
        8,
        moveStart.x + DRAG_THRESHOLD_PX,
        moveStart.y,
      ),
    ).toBeUndefined()
  })

  it('returns undefined when the pointer is back over the origin cell', () => {
    expect(
      resolveMoveTarget(moveStart, moveStart.idx, 400, 400),
    ).toBeUndefined()
  })

  it('returns the hovered cell for a committed drag over a different cell', () => {
    expect(resolveMoveTarget(moveStart, 8, 400, 400)).toBe(8)
  })

  it('honours a custom threshold', () => {
    expect(resolveMoveTarget(moveStart, 8, 120, 100, 50)).toBeUndefined()
    expect(resolveMoveTarget(moveStart, 8, 160, 100, 50)).toBe(8)
  })
})

describe('computeHoveringIdx', () => {
  // A 4x2 grid (cols=4, rows=2) over a 400x200 box, so each cell is 100x100.
  const cols = 4
  const rows = 2
  const width = 400
  const height = 200

  it('resolves the top-left cell', () => {
    expect(computeHoveringIdx(cols, rows, width, height, 0, 0)).toBe(0)
  })

  it('resolves a cell in the middle of the grid', () => {
    expect(computeHoveringIdx(cols, rows, width, height, 250, 150)).toBe(6)
  })

  it('resolves the bottom-right-most in-bounds pixel', () => {
    expect(computeHoveringIdx(cols, rows, width, height, 399, 199)).toBe(7)
  })

  it('returns undefined when x is negative (pointer left of the grid)', () => {
    // Regression: touch pointers are implicitly captured to their pointerdown
    // target, so `pointerleave` never fires while a finger drags outside the
    // grid's bounds the way `mouseleave` does for a mouse. Without this
    // bounds check a drag released off-grid would commit against whatever
    // cell the out-of-bounds coordinates happened to floor to.
    expect(
      computeHoveringIdx(cols, rows, width, height, -1, 50),
    ).toBeUndefined()
  })

  it('returns undefined when y is negative (pointer above the grid)', () => {
    expect(
      computeHoveringIdx(cols, rows, width, height, 50, -1),
    ).toBeUndefined()
  })

  it('returns undefined when x is at or past the right edge', () => {
    expect(
      computeHoveringIdx(cols, rows, width, height, 400, 50),
    ).toBeUndefined()
  })

  it('returns undefined when y is at or past the bottom edge', () => {
    expect(
      computeHoveringIdx(cols, rows, width, height, 50, 200),
    ).toBeUndefined()
  })
})
