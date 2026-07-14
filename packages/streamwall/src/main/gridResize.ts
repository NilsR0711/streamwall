import { clampGridDimension, remapGridAssignments } from 'streamwall-shared'
import * as Y from 'yjs'

/**
 * Collaborators the grid-resize orchestration needs from the main process,
 * expressed as an explicit interface so the ordering-sensitive logic can be
 * unit-tested without the Electron runtime.
 */
export interface GridResizeContext {
  /** Yjs map of grid cell index (as string) -> a `{ streamId }` map. */
  viewsState: Y.Map<Y.Map<string | undefined>>
  /** Runs `fn` inside the shared `stateDoc.transact`, batching the mutations. */
  transact: (fn: () => void) => void
  /** Current column count of the wall (used to read each cell's (x, y)). */
  getCols: () => number
  /**
   * Current row count of the wall. Bounds `oldCols * oldRows` so a stale
   * `viewsState` key left over from a previously larger grid (see
   * `getCols`) is dropped as out-of-range rather than remapped by
   * coincidence (issue #17).
   */
  getRows: () => number
  /** Applies the new grid dimensions to the wall (mutates the shared config). */
  setGridSize: (cols: number, rows: number) => void
}

/**
 * Resizes the wall grid in response to a `set-grid-size` command, preserving
 * every stream that still fits the new grid.
 *
 * Ordering is critical. The stateDoc's `observeDeep` observer
 * (`updateViewsFromStateDoc`) runs *synchronously* at the end of `transact`,
 * re-laying the wall out from the freshly written assignments. That layout reads
 * the grid dimensions from the shared config, so the config MUST already hold
 * the new `cols`/`rows` before the transact runs. Otherwise a stream remapped
 * into a cell beyond the old grid (e.g. cell 3 of a 2x2 grid moving to cell 4 of
 * a 3x3 grid) produces no layout box, and `StreamWindow.setViews` destroys the
 * running view — making the stream go black and fully reload on every grid grow
 * (issue #15).
 *
 * @returns the clamped dimensions actually applied.
 */
export function applyGridResize(
  ctx: GridResizeContext,
  requestedCols: number,
  requestedRows: number,
): { cols: number; rows: number } {
  const cols = clampGridDimension(requestedCols)
  const rows = clampGridDimension(requestedRows)
  const oldCols = ctx.getCols()
  const oldRows = ctx.getRows()

  // Read current assignments keyed by old cell index.
  const oldAssignments = new Map<number, string | undefined>()
  for (const [key, viewData] of ctx.viewsState) {
    oldAssignments.set(Number(key), viewData.get('streamId'))
  }

  // Remap by (x, y) into the new grid, then rebuild the views map.
  const newAssignments = remapGridAssignments(
    oldCols,
    cols,
    rows,
    oldAssignments,
    oldRows,
  )

  // Update the grid dimensions BEFORE the transact so the synchronous observer
  // lays the wall out against the new grid. See the ordering note above.
  ctx.setGridSize(cols, rows)

  ctx.transact(() => {
    for (const key of [...ctx.viewsState.keys()]) {
      ctx.viewsState.delete(key)
    }
    for (const [idx, streamId] of newAssignments) {
      const data = new Y.Map<string | undefined>()
      data.set('streamId', streamId)
      ctx.viewsState.set(String(idx), data)
    }
  })

  return { cols, rows }
}
