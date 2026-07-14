/**
 * Pure computation for grid drag-move (swap) and resize commits.
 *
 * These decide *what* a committed gesture changes — which grid cell ends up
 * with which streamId — independent of the Yjs doc mutation and pointer-event
 * wiring in the `ControlUI` component, so the assignment math can be
 * unit-tested in isolation.
 */
import { idxToCoords } from 'streamwall-shared'

export interface SwapBox {
  /** Grid cell indexes occupied by this box. */
  spaces: number[]
  streamId: string | undefined
}

/**
 * Compute the streamId reassignment for swapping the box anchored at
 * `fromIdx` with the box anchored at `toIdx`: every space of one box takes on
 * the other box's streamId, so boxes of unequal size swap correctly. A box
 * missing from `boxes` is treated as a single space at its own index (mirrors
 * dropping onto a grid cell that has no box yet). Returns an empty map — a
 * no-op — when `fromIdx` and `toIdx` name the same box.
 */
export function computeSwap(
  boxes: Map<number, SwapBox>,
  fromIdx: number,
  toIdx: number,
): Map<number, string | undefined> {
  if (fromIdx === toIdx) {
    return new Map()
  }
  const fromBox = boxes.get(fromIdx)
  const toBox = boxes.get(toIdx)
  const assignments = new Map<number, string | undefined>()
  for (const idx of fromBox?.spaces ?? [fromIdx]) {
    assignments.set(idx, toBox?.streamId)
  }
  for (const idx of toBox?.spaces ?? [toIdx]) {
    assignments.set(idx, fromBox?.streamId)
  }
  return assignments
}

/**
 * Compute the streamId assignment for a resize gesture: every grid cell in
 * the rectangle spanned by `anchorIdx` and `hoverIdx` (inclusive, in either
 * drag direction) is assigned `streamId`, overwriting whatever stream(s)
 * currently occupy that box.
 */
export function computeResizeAssignments(
  cols: number,
  anchorIdx: number,
  hoverIdx: number,
  streamId: string,
): Map<number, string> {
  const { x: anchorX, y: anchorY } = idxToCoords(cols, anchorIdx)
  const { x: hoverX, y: hoverY } = idxToCoords(cols, hoverIdx)
  const lowX = Math.min(anchorX, hoverX)
  const highX = Math.max(anchorX, hoverX)
  const lowY = Math.min(anchorY, hoverY)
  const highY = Math.max(anchorY, hoverY)
  const assignments = new Map<number, string>()
  for (let y = lowY; y <= highY; y++) {
    for (let x = lowX; x <= highX; x++) {
      assignments.set(cols * y + x, streamId)
    }
  }
  return assignments
}
