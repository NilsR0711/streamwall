/**
 * Pure decision helpers for grid drag-move and resize gestures.
 *
 * These rules live outside the `ControlUI` component so the logic that decides
 * *whether* and *where* a gesture commits can be unit-tested in isolation. They
 * encode the fix for the "released off the grid commits against a stale cell"
 * bug: a gesture only commits while the pointer is over a grid cell.
 */

/** Minimum pointer travel (px) before a mouse-down is treated as a drag-move. */
export const DRAG_THRESHOLD_PX = 5

export interface MoveStart {
  idx: number
  x: number
  y: number
}

/**
 * A gesture may only be started or committed with the primary (left) button.
 * Right/middle-button presses must not move or resize tiles.
 */
export function isPrimaryButton(button: number): boolean {
  return button === 0
}

/**
 * Resolve which cell a drag-move should commit to.
 *
 * Returns the target cell index, or `undefined` when the gesture should be a
 * no-op — including when the pointer is released off the grid (`hoveringIdx`
 * is `undefined`), has not travelled past the drag threshold, or is back over
 * the origin cell.
 */
export function resolveMoveTarget(
  moveStart: MoveStart | undefined,
  hoveringIdx: number | undefined,
  pointerX: number,
  pointerY: number,
  threshold: number = DRAG_THRESHOLD_PX,
): number | undefined {
  if (moveStart == null || hoveringIdx == null) {
    return undefined
  }
  const moved = Math.hypot(pointerX - moveStart.x, pointerY - moveStart.y)
  if (moved <= threshold || hoveringIdx === moveStart.idx) {
    return undefined
  }
  return hoveringIdx
}
