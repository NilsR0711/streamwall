import { describe, expect, it } from 'vitest'

import {
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
