/**
 * Pure computation for grid drag-move (swap) and resize commits.
 *
 * These decide *what* a committed gesture changes — which grid cell ends up
 * with which streamId — independent of the Yjs doc mutation and pointer-event
 * wiring in the `ControlUI` component, so the assignment math can be
 * unit-tested in isolation.
 */
import { asCellIdx, type CellIdx, idxToCoords } from 'streamwall-shared'

export interface SwapBox {
  /** Grid cell indexes occupied by this box. */
  spaces: CellIdx[]
  streamId: string | undefined
}

/**
 * Translate `spaces` (a box's grid-cell footprint) by the offset from
 * `fromIdx` to `toIdx`, clamping the offset so the whole footprint's
 * bounding box stays on-grid — the box moves and clamps as a single rigid
 * shape rather than distorting or having individual cells clamp
 * independently.
 */
function translateFootprint(
  cols: number,
  rows: number,
  spaces: CellIdx[],
  fromIdx: CellIdx,
  toIdx: CellIdx,
): CellIdx[] {
  const coords = spaces.map((idx) => idxToCoords(cols, idx))
  const { x: fromX, y: fromY } = idxToCoords(cols, fromIdx)
  const { x: toX, y: toY } = idxToCoords(cols, toIdx)
  let dx = toX - fromX
  let dy = toY - fromY

  const minX = Math.min(...coords.map(({ x }) => x))
  const maxX = Math.max(...coords.map(({ x }) => x))
  const minY = Math.min(...coords.map(({ y }) => y))
  const maxY = Math.max(...coords.map(({ y }) => y))

  if (minX + dx < 0) {
    dx = -minX
  } else if (maxX + dx > cols - 1) {
    dx = cols - 1 - maxX
  }
  if (minY + dy < 0) {
    dy = -minY
  } else if (maxY + dy > rows - 1) {
    dy = rows - 1 - maxY
  }

  return coords.map(({ x, y }) => asCellIdx(cols * (y + dy) + (x + dx)))
}

/**
 * Compute the streamId reassignment for swapping the box anchored at
 * `fromIdx` with the box anchored at `toIdx`: every space of one box takes on
 * the other box's streamId, so boxes of unequal size swap correctly. A box
 * missing from `boxes` is treated as a single space at its own index (mirrors
 * dropping onto a grid cell that has no box yet). Returns an empty map — a
 * no-op — when `fromIdx` and `toIdx` name the same box.
 *
 * Dropping onto a cell with no box (`toBox` missing) is a move, not a swap:
 * rather than collapsing the source box down to the single target cell, its
 * whole footprint is translated to the drop location (clamped to the grid)
 * so a merged tile keeps its size and shape.
 */
export function computeSwap(
  boxes: Map<CellIdx, SwapBox>,
  fromIdx: CellIdx,
  toIdx: CellIdx,
  cols: number,
  rows: number,
): Map<CellIdx, string | undefined> {
  if (fromIdx === toIdx) {
    return new Map()
  }
  const fromBox = boxes.get(fromIdx)
  const toBox = boxes.get(toIdx)
  const assignments = new Map<CellIdx, string | undefined>()

  if (fromBox !== undefined && toBox === undefined) {
    const targetSpaces = translateFootprint(
      cols,
      rows,
      fromBox.spaces,
      fromIdx,
      toIdx,
    )
    for (const idx of fromBox.spaces) {
      assignments.set(idx, undefined)
    }
    for (const idx of targetSpaces) {
      assignments.set(idx, fromBox.streamId)
    }
    return assignments
  }

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
  anchorIdx: CellIdx,
  hoverIdx: CellIdx,
  handle: ResizeHandle,
  originalSpaces: CellIdx[],
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
  anchorIdx: CellIdx,
  hoverIdx: CellIdx,
  handle: ResizeHandle,
  originalSpaces: CellIdx[],
  idx: CellIdx,
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
/**
 * Compute the hover index a single arrow-key press would resize a box to, so
 * a resize handle can be operated by keyboard as well as pointer drag. Each
 * press moves one axis by one grid cell, mirroring the axis lock a pointer
 * drag on the same handle already applies ('e' is width-only, 's' is
 * height-only, 'se' moves whichever axis the pressed arrow names).
 *
 * Returns `undefined` — a no-op — when the key isn't an arrow key, names the
 * handle's locked cross-axis, or would move past the anchor (shrinking below
 * a 1-cell box) or past the grid's far edge.
 */
export function computeKeyboardResizeHoverIdx(
  cols: number,
  rows: number,
  anchorIdx: CellIdx,
  handle: ResizeHandle,
  originalSpaces: CellIdx[],
  key: string,
): CellIdx | undefined {
  const dx = key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0
  const dy = key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : 0
  if (dx === 0 && dy === 0) {
    return undefined
  }
  if (handle === 'e' && dy !== 0) {
    return undefined
  }
  if (handle === 's' && dx !== 0) {
    return undefined
  }

  const { x: anchorX, y: anchorY } = idxToCoords(cols, anchorIdx)
  const originalCoords = originalSpaces.map((idx) => idxToCoords(cols, idx))
  const maxX = Math.max(...originalCoords.map(({ x }) => x))
  const maxY = Math.max(...originalCoords.map(({ y }) => y))

  const newMaxX = Math.min(cols - 1, Math.max(anchorX, maxX + dx))
  const newMaxY = Math.min(rows - 1, Math.max(anchorY, maxY + dy))
  if (newMaxX === maxX && newMaxY === maxY) {
    return undefined
  }
  return asCellIdx(cols * newMaxY + newMaxX)
}

/**
 * Reports whether committing a resize gesture would overwrite any cell that
 * currently belongs to a stream other than the one being resized. Growing a
 * tile over part of a neighbor silently claims those cells (see
 * {@link computeResizeAssignments}) and fragments the remainder of the
 * neighbor into smaller boxes — callers use this to gate the commit behind a
 * confirmation, mirroring the grid-shrink confirm in `handleSetGridSize`.
 */
export function resizeWouldOverwriteOtherStream(
  cols: number,
  anchorIdx: CellIdx,
  hoverIdx: CellIdx,
  streamId: string,
  handle: ResizeHandle,
  originalSpaces: CellIdx[],
  currentAssignments: Map<CellIdx, string | undefined>,
): boolean {
  const { minX, maxX, minY, maxY } = computeResizeBox(
    cols,
    anchorIdx,
    hoverIdx,
    handle,
    originalSpaces,
  )
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const existing = currentAssignments.get(asCellIdx(cols * y + x))
      if (existing !== undefined && existing !== '' && existing !== streamId) {
        return true
      }
    }
  }
  return false
}

export function computeResizeAssignments(
  cols: number,
  anchorIdx: CellIdx,
  hoverIdx: CellIdx,
  streamId: string,
  handle: ResizeHandle,
  originalSpaces: CellIdx[],
): Map<CellIdx, string | undefined> {
  const { minX, maxX, minY, maxY } = computeResizeBox(
    cols,
    anchorIdx,
    hoverIdx,
    handle,
    originalSpaces,
  )
  const assignments = new Map<CellIdx, string | undefined>()
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      assignments.set(asCellIdx(cols * y + x), streamId)
    }
  }
  for (const idx of originalSpaces) {
    if (!assignments.has(idx)) {
      assignments.set(idx, undefined)
    }
  }
  return assignments
}
