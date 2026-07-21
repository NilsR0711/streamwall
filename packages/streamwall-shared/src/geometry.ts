import { isEqual } from 'lodash-es'
import type { ContentKind } from './types.ts'
import { asCellIdx, type CellIdx } from './viewAddressing.ts'

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
  spaces: CellIdx[]
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
    const spaces: CellIdx[] = [asCellIdx(idx)]
    const content = viewContentMap.get(String(idx))

    let maxY
    for (maxY = y + 1; maxY < rows; maxY++) {
      if (!isPosContent(x, maxY, content)) {
        break
      }
      spaces.push(asCellIdx(cols * maxY + x))
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
        spaces.push(asCellIdx(cols * cy + cx))
      }
    }
    const w = cx - x
    const h = maxY - y
    spaces.sort((a, b) => a - b)
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

/**
 * Builds a {@link ViewContentMap} in which a single content fills every cell of
 * a `cols`×`rows` grid. Feeding this to {@link boxesFromViewContentMap} yields
 * exactly one box spanning the whole grid, which is how a view is expanded to
 * fill the entire wall (issue #362). The map is derived entirely from the
 * arguments and never touches the persisted grid assignments, so expansion
 * stays a transient, view-local override.
 */
export function fullscreenViewContentMap(
  cols: number,
  rows: number,
  content: ViewContent,
): ViewContentMap {
  const map: ViewContentMap = new Map()
  for (let idx = 0; idx < cols * rows; idx++) {
    map.set(String(idx), content)
  }
  return map
}

/** A box's position and size in grid-cell units, as produced by {@link boxesFromViewContentMap}. */
export interface GridBox {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Converts a box's grid-cell coordinates into a pixel rectangle. Flooring
 * width/height by cols/rows (needed since cells must be whole pixels) leaves
 * up to `cols-1`/`rows-1` residual pixels uncovered at the right/bottom edge;
 * a box that reaches the last column/row absorbs that remainder instead of
 * leaving a gap.
 */
export function computeBoxRect(
  cols: number,
  rows: number,
  width: number,
  height: number,
  box: GridBox,
): Rectangle {
  const spaceWidth = Math.floor(width / cols)
  const spaceHeight = Math.floor(height / rows)
  const { x, y, w, h } = box
  const reachesRightEdge = x + w >= cols
  const reachesBottomEdge = y + h >= rows
  return {
    x: spaceWidth * x,
    y: spaceHeight * y,
    width: reachesRightEdge ? width - spaceWidth * x : spaceWidth * w,
    height: reachesBottomEdge ? height - spaceHeight * y : spaceHeight * h,
  }
}

export function idxToCoords(cols: number, idx: number) {
  const x = idx % cols
  const y = Math.floor(idx / cols)
  return { x, y }
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
 * Reports whether any cell in `assignments` holds a stream. Used to decide
 * whether an operation that unconditionally replaces the whole grid (e.g.
 * loading a layout preset) needs a confirmation, since unlike a resize there
 * is no partial overlap to preserve.
 *
 * @param assignments Map of cell index -> streamId (undefined/'' = empty).
 */
export function hasGridAssignments(
  assignments: Map<number, string | undefined>,
): boolean {
  for (const streamId of assignments.values()) {
    if (streamId !== undefined && streamId !== '') {
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
 * @param oldRows Row count of the true old grid. When given, entries whose
 *   index falls outside `oldCols * oldRows` are dropped as stale before
 *   remapping, rather than being read against `oldCols` alone — a stale key
 *   left over from a previously larger grid config can otherwise land inside
 *   the new grid by coincidence and resurface as a ghost stream (issue #17).
 *   Omit when `oldAssignments` is already known to cover exactly the old grid.
 */
export function remapGridAssignments(
  oldCols: number,
  newCols: number,
  newRows: number,
  oldAssignments: Map<number, string | undefined>,
  oldRows?: number,
): Map<number, string | undefined> {
  const result = new Map<number, string | undefined>()
  for (let idx = 0; idx < newCols * newRows; idx++) {
    result.set(idx, undefined)
  }
  const oldCellCount = oldRows === undefined ? undefined : oldCols * oldRows
  for (const [oldIdx, streamId] of oldAssignments) {
    if (streamId === undefined || streamId === '') {
      continue
    }
    if (oldCellCount !== undefined && oldIdx >= oldCellCount) {
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
