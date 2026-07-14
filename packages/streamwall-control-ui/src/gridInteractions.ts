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

/** Which edge(s) of the box a resize handle drags. */
export type ResizeHandle = 'e' | 's' | 'se'

/**
 * The grid rectangle a resize gesture currently spans. `anchorIdx`'s cell is
 * always the box's fixed top-left corner (`minX`/`minY`), so hover positions
 * above or left of it clamp back to the anchor instead of spanning backward
 * past it — that would grow the box in the wrong direction. An edge handle
 * ('e' or 's') only drags its own axis: the other axis stays locked to the
 * original box's extent (from `originalSpaces`) regardless of hover.
 */
function computeResizeBox(
  cols: number,
  anchorIdx: number,
  hoverIdx: number,
  handle: ResizeHandle,
  originalSpaces: number[],
) {
  const { x: anchorX, y: anchorY } = idxToCoords(cols, anchorIdx)
  const { x: hoverX, y: hoverY } = idxToCoords(cols, hoverIdx)
  const originalCoords = originalSpaces.map((idx) => idxToCoords(cols, idx))
  const originalMaxX = Math.max(...originalCoords.map(({ x }) => x))
  const originalMaxY = Math.max(...originalCoords.map(({ y }) => y))
  return {
    minX: anchorX,
    maxX: handle === 's' ? originalMaxX : Math.max(anchorX, hoverX),
    minY: anchorY,
    maxY: handle === 'e' ? originalMaxY : Math.max(anchorY, hoverY),
  }
}

/** Whether `idx` falls inside the box an in-progress resize gesture spans — used to preview which cells a commit would overwrite. */
export function isIdxInResizeBox(
  cols: number,
  anchorIdx: number,
  hoverIdx: number,
  handle: ResizeHandle,
  originalSpaces: number[],
  idx: number,
): boolean {
  const { minX, maxX, minY, maxY } = computeResizeBox(
    cols,
    anchorIdx,
    hoverIdx,
    handle,
    originalSpaces,
  )
  const { x, y } = idxToCoords(cols, idx)
  return x >= minX && x <= maxX && y >= minY && y <= maxY
}

/**
 * Compute the streamId assignment for a resize gesture: every grid cell in
 * the box `computeResizeBox` spans is assigned `streamId`, overwriting
 * whatever stream(s) currently occupy that box. Any cell in `originalSpaces`
 * (the box's extent before this gesture) that falls outside the new box is
 * explicitly cleared (set to `undefined`) so a shrink actually vacates it,
 * rather than leaving a stale streamId that keeps rendering as part of the
 * (now smaller) box.
 */
export function computeResizeAssignments(
  cols: number,
  anchorIdx: number,
  hoverIdx: number,
  streamId: string,
  handle: ResizeHandle,
  originalSpaces: number[],
): Map<number, string | undefined> {
  const { minX, maxX, minY, maxY } = computeResizeBox(
    cols,
    anchorIdx,
    hoverIdx,
    handle,
    originalSpaces,
  )
  const assignments = new Map<number, string | undefined>()
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      assignments.set(cols * y + x, streamId)
    }
  }
  for (const idx of originalSpaces) {
    if (!assignments.has(idx)) {
      assignments.set(idx, undefined)
    }
  }
  return assignments
}
