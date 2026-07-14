import * as Y from 'yjs'

/**
 * Collaborators the startup view-state seeding needs from the main process.
 */
export interface ViewsStateInitContext {
  /** Yjs map of grid cell index (as string) -> a `{ streamId }` map. */
  viewsState: Y.Map<Y.Map<string | undefined>>
  /** Runs `fn` inside the shared `stateDoc.transact`, batching the mutations. */
  transact: (fn: () => void) => void
}

/**
 * Seeds `viewsState` with an empty cell for every index of the configured
 * grid, and prunes any leftover keys outside that range.
 *
 * The persisted Yjs doc keeps every cell key ever created across restarts,
 * and the fill used to only ever add missing keys. A key from a previous,
 * larger grid config (e.g. index 60 from an old 8x8 wall) would then survive
 * invisibly once the app restarted with a smaller grid, and could resurface
 * as a ghost stream in an arbitrary cell the next time the grid was grown
 * (issue #17).
 */
export function initializeViewsState(
  ctx: ViewsStateInitContext,
  cols: number,
  rows: number,
): void {
  const totalCells = cols * rows
  ctx.transact(() => {
    for (const key of [...ctx.viewsState.keys()]) {
      if (Number(key) >= totalCells) {
        ctx.viewsState.delete(key)
      }
    }
    for (let i = 0; i < totalCells; i++) {
      if (ctx.viewsState.has(String(i))) {
        continue
      }
      const data = new Y.Map<string | undefined>()
      data.set('streamId', undefined)
      ctx.viewsState.set(String(i), data)
    }
  })
}
