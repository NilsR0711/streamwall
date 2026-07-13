import { isEqual } from 'lodash-es'
import type { ContentKind } from './types.ts'

/**
 * A rectangle in screen coordinates. Structurally identical to Electron's
 * `Rectangle`, but defined locally so this shared package does not depend on
 * the (heavy, main-process-only) `electron` module.
 */
export interface Rectangle {
  x: number
  y: number
  width: number
  height: number
}

export interface ViewPos extends Rectangle {
  /**
   * Grid space indexes inhabited by the view.
   */
  spaces: number[]
}

export interface ViewContent {
  url: string
  kind: ContentKind
}
export type ViewContentMap = Map<string, ViewContent>

export function boxesFromViewContentMap(
  cols: number,
  rows: number,
  viewContentMap: ViewContentMap,
) {
  const boxes = []
  const visited = new Set()

  function isPosContent(
    x: number,
    y: number,
    content: ViewContent | undefined,
  ) {
    const checkIdx = cols * y + x
    return (
      !visited.has(checkIdx) &&
      isEqual(viewContentMap.get(String(checkIdx)), content)
    )
  }

  function findLargestBox(x: number, y: number) {
    const idx = cols * y + x
    const spaces = [idx]
    const content = viewContentMap.get(String(idx))

    let maxY
    for (maxY = y + 1; maxY < rows; maxY++) {
      if (!isPosContent(x, maxY, content)) {
        break
      }
      spaces.push(cols * maxY + x)
    }

    let cx: number
    let cy: number
    scan: for (cx = x + 1; cx < cols; cx++) {
      for (cy = y; cy < maxY; cy++) {
        if (!isPosContent(cx, cy, content)) {
          break scan
        }
      }
      for (let cy = y; cy < maxY; cy++) {
        spaces.push(cols * cy + cx)
      }
    }
    const w = cx - x
    const h = maxY - y
    spaces.sort()
    return { content, x, y, w, h, spaces }
  }

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const idx = cols * y + x
      if (visited.has(idx) || viewContentMap.get(String(idx)) === undefined) {
        continue
      }

      const box = findLargestBox(x, y)
      boxes.push(box)
      for (const boxIdx of box.spaces) {
        visited.add(boxIdx)
      }
    }
  }

  return boxes
}

export function idxToCoords(cols: number, idx: number) {
  const x = idx % cols
  const y = Math.floor(idx / cols)
  return { x, y }
}

export function idxInBox(
  cols: number,
  start: number,
  end: number,
  idx: number,
) {
  const { x: startX, y: startY } = idxToCoords(cols, start)
  const { x: endX, y: endY } = idxToCoords(cols, end)
  const { x, y } = idxToCoords(cols, idx)
  const lowX = Math.min(startX, endX)
  const highX = Math.max(startX, endX)
  const lowY = Math.min(startY, endY)
  const highY = Math.max(startY, endY)
  const xInBox = x >= lowX && x <= highX
  const yInBox = y >= lowY && y <= highY
  return xInBox && yInBox
}

/** Inclusive bounds for grid dimensions (columns / rows). */
export const GRID_MIN = 1
export const GRID_MAX = 8

/** Rounds and clamps a grid dimension into [GRID_MIN, GRID_MAX]. */
export function clampGridDimension(n: number): number {
  if (!Number.isFinite(n)) {
    return GRID_MIN
  }
  return Math.max(GRID_MIN, Math.min(GRID_MAX, Math.round(n)))
}

/**
 * Parses raw grid-dimension input from a text field. Unlike
 * {@link clampGridDimension}, this does *not* silently clamp: an empty field,
 * non-numeric text, `NaN`, or a value outside [GRID_MIN, GRID_MAX] all return
 * `null` so the caller can ignore the intermediate keystroke instead of
 * collapsing the grid. Fractional input that rounds into range is accepted.
 */
export function parseGridDimensionInput(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') {
    return null
  }
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) {
    return null
  }
  const rounded = Math.round(parsed)
  if (rounded < GRID_MIN || rounded > GRID_MAX) {
    return null
  }
  return rounded
}

/**
 * Reports whether resizing the grid would permanently drop any non-empty cell.
 * Mirrors the (x, y)-preserving drop rule of {@link remapGridAssignments}: a
 * cell survives only if its coordinates still fall within the new grid.
 *
 * @param oldCols Column count of the current grid (needed to read (x, y)).
 * @param newCols Column count of the target grid.
 * @param newRows Row count of the target grid.
 * @param assignments Map of current cell index -> streamId (undefined/'' = empty).
 */
export function gridWouldDropAssignments(
  oldCols: number,
  newCols: number,
  newRows: number,
  assignments: Map<number, string | undefined>,
): boolean {
  for (const [oldIdx, streamId] of assignments) {
    if (streamId === undefined || streamId === '') {
      continue
    }
    const x = oldIdx % oldCols
    const y = Math.floor(oldIdx / oldCols)
    if (x >= newCols || y >= newRows) {
      return true
    }
  }
  return false
}

/**
 * Remaps grid cell assignments when the grid dimensions change. Each non-empty
 * assignment is preserved at the same (x, y) position if that position still
 * exists in the new grid; assignments that fall outside the new grid are
 * dropped. The returned map covers every cell of the new grid (empty cells are
 * `undefined`).
 *
 * @param oldCols Column count of the current grid (needed to read (x, y)).
 * @param newCols Column count of the target grid.
 * @param newRows Row count of the target grid.
 * @param oldAssignments Map of old cell index -> streamId (undefined/'' = empty).
 */
export function remapGridAssignments(
  oldCols: number,
  newCols: number,
  newRows: number,
  oldAssignments: Map<number, string | undefined>,
): Map<number, string | undefined> {
  const result = new Map<number, string | undefined>()
  for (let idx = 0; idx < newCols * newRows; idx++) {
    result.set(idx, undefined)
  }
  for (const [oldIdx, streamId] of oldAssignments) {
    if (streamId === undefined || streamId === '') {
      continue
    }
    const x = oldIdx % oldCols
    const y = Math.floor(oldIdx / oldCols)
    if (x < newCols && y < newRows) {
      result.set(newCols * y + x, streamId)
    }
  }
  return result
}
