/**
 * Pure decision helpers for grid drag-move and resize gestures.
 *
 * These rules live outside the `ControlUI` component so the logic that decides
 * *whether* and *where* a gesture commits can be unit-tested in isolation. They
 * encode the fix for the "released off the grid commits against a stale cell"
 * bug: a gesture only commits while the pointer is over a grid cell.
 *
 * Every index here is a *grid cell index* (`CellIdx`), never a stable view id:
 * these helpers derive cells from raw pointer coordinates (issue #507).
 */

import { asCellIdx, type CellIdx } from 'streamwall-shared'

/** Minimum pointer travel (px) before a mouse-down is treated as a drag-move. */
export const DRAG_THRESHOLD_PX = 5

export interface MoveStart {
  idx: CellIdx
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
/**
 * Resolve which grid cell a pointer at (x, y) within a grid box of the given
 * size is hovering, or `undefined` when the position is outside the box.
 *
 * Mouse hover tracking relies on `mouseleave` to clear the hovered cell once
 * the pointer leaves the grid mid-drag. Touch pointers are implicitly
 * captured to their `pointerdown` target, so no boundary events (including
 * `pointerleave`) fire on the grid while a finger drags outside its bounds.
 * This bounds check reproduces that "off grid" signal from raw coordinates
 * so a touch drag released outside the grid can't commit against whatever
 * cell the out-of-bounds coordinates happen to floor to.
 */
export function computeHoveringIdx(
  cols: number,
  rows: number,
  width: number,
  height: number,
  x: number,
  y: number,
): CellIdx | undefined {
  if (x < 0 || y < 0 || x >= width || y >= height) {
    return undefined
  }
  const spaceWidth = width / cols
  const spaceHeight = height / rows
  return asCellIdx(
    Math.floor(y / spaceHeight) * cols + Math.floor(x / spaceWidth),
  )
}

export function resolveMoveTarget(
  moveStart: MoveStart | undefined,
  hoveringIdx: CellIdx | undefined,
  pointerX: number,
  pointerY: number,
  threshold: number = DRAG_THRESHOLD_PX,
): CellIdx | undefined {
  if (moveStart == null || hoveringIdx == null) {
    return undefined
  }
  const moved = Math.hypot(pointerX - moveStart.x, pointerY - moveStart.y)
  if (moved <= threshold || hoveringIdx === moveStart.idx) {
    return undefined
  }
  return hoveringIdx
}
