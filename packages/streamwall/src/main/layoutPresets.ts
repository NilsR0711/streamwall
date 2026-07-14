import type { LayoutPreset } from 'streamwall-shared'
import * as Y from 'yjs'

/** Maximum number of saved layout presets, bounding unbounded storage growth. */
export const MAX_LAYOUT_PRESETS = 50

export interface LayoutPresetSaveContext {
  /** Yjs map of grid cell index (as string) -> a `{ streamId }` map. */
  viewsState: Y.Map<Y.Map<string | undefined>>
  cols: number
  rows: number
}

/** Captures the current grid dimensions and per-cell stream assignments as a named preset. */
export function buildLayoutPreset(
  ctx: LayoutPresetSaveContext,
  id: string,
  name: string,
): LayoutPreset {
  const views: LayoutPreset['views'] = {}
  for (const [key, viewData] of ctx.viewsState) {
    const streamId = viewData.get('streamId')
    if (streamId) {
      views[key] = { streamId }
    }
  }
  return { id, name, cols: ctx.cols, rows: ctx.rows, views }
}

/**
 * Appends `preset` to `presets`, bounding the list to `MAX_LAYOUT_PRESETS` by
 * dropping the oldest entries when full — saving a new preset always succeeds.
 */
export function addLayoutPreset(
  presets: LayoutPreset[],
  preset: LayoutPreset,
): LayoutPreset[] {
  const next = [...presets, preset]
  return next.length > MAX_LAYOUT_PRESETS
    ? next.slice(next.length - MAX_LAYOUT_PRESETS)
    : next
}

/**
 * Collaborators the layout-preset load orchestration needs from the main
 * process, mirroring `GridResizeContext` in `gridResize.ts`.
 */
export interface LayoutPresetLoadContext {
  viewsState: Y.Map<Y.Map<string | undefined>>
  /** Runs `fn` inside the shared `stateDoc.transact`, batching the mutations. */
  transact: (fn: () => void) => void
  /** Applies the preset's grid dimensions to the wall (mutates the shared config). */
  setGridSize: (cols: number, rows: number) => void
}

/**
 * Resizes the wall grid and rewrites `viewsState` to exactly match a saved
 * layout preset.
 *
 * Ordering mirrors `applyGridResize`: the grid size is applied BEFORE the
 * transact so the stateDoc's synchronous `observeDeep` observer re-lays the
 * wall out against the new dimensions (see gridResize.ts for the full
 * rationale, issue #15).
 */
export function applyLayoutPreset(
  ctx: LayoutPresetLoadContext,
  preset: LayoutPreset,
): void {
  ctx.setGridSize(preset.cols, preset.rows)

  ctx.transact(() => {
    for (const key of [...ctx.viewsState.keys()]) {
      ctx.viewsState.delete(key)
    }
    for (let i = 0; i < preset.cols * preset.rows; i++) {
      const data = new Y.Map<string | undefined>()
      data.set('streamId', preset.views[String(i)]?.streamId)
      ctx.viewsState.set(String(i), data)
    }
  })
}
