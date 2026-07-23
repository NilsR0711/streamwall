import {
  type StreamData,
  type StreamList,
  type ViewContentMap,
  fullscreenViewContentMap,
} from 'streamwall-shared'
import * as Y from 'yjs'

/**
 * Indexes a stream list by `_id` for O(1) cell resolution. First entry wins on
 * a duplicate id, preserving the first-match behaviour of the `streams.find`
 * scan this replaces.
 */
function buildStreamById(streams: StreamList): Map<string, StreamData> {
  const byId = new Map<string, StreamData>()
  for (const stream of streams) {
    if (stream._id != null && !byId.has(stream._id)) {
      byId.set(stream._id, stream)
    }
  }
  return byId
}

export interface DeriveWallViewsInput {
  /** The view currently expanded to fill the wall, or null for the normal grid. */
  fullscreenViewIdx: number | null
  /** The streams the grid assignments resolve against. */
  streams: StreamList
  /** Yjs map of grid cell index (as string) -> a `{ streamId }` map. */
  viewsState: Y.Map<Y.Map<string | undefined>>
  cols: number
  rows: number
}

/**
 * The wall layout to render, either a single stream expanded across every cell
 * or the normal per-cell grid.
 */
export type WallViews =
  | { mode: 'fullscreen'; contentMap: ViewContentMap }
  | {
      mode: 'normal'
      contentMap: ViewContentMap
      /**
       * True when a fullscreen view was requested but its stream is gone, so
       * the caller should clear the stale `fullscreenViewIdx` override.
       */
      clearedFullscreen: boolean
    }

/**
 * Derives the wall's view-content map from the current grid assignments and
 * streams.
 *
 * When a view is expanded to fullscreen (issue #362), the derived layout is
 * overridden so the expanded stream fills every grid cell — one wall-spanning
 * box — with the other views parked (hidden but kept alive) behind it (issue
 * #369). This override is transient: it reads the expanded stream from
 * `viewsState` but never writes back, so the persisted grid assignments are
 * untouched and a later collapse restores the normal layout verbatim.
 *
 * If the expanded stream is gone (its cell was cleared or it dropped out of the
 * data source), the result falls back to the normal layout and signals
 * `clearedFullscreen` so the caller can drop the stale override.
 */
export function deriveWallViews({
  fullscreenViewIdx,
  streams,
  viewsState,
  cols,
  rows,
}: DeriveWallViewsInput): WallViews {
  // Resolve cell assignments through an id -> stream index built once per
  // invocation, rather than scanning the whole stream list per cell. Prefer the
  // index the data pipeline already attached (see combine.ts); fall back to
  // building one here so callers that pass a bare list still work. First entry
  // wins on a duplicate id, matching the previous `streams.find(...)` scan.
  const byId = streams.byId ?? buildStreamById(streams)

  if (fullscreenViewIdx != null) {
    const streamId = viewsState.get(String(fullscreenViewIdx))?.get('streamId')
    const stream = streamId != null ? byId.get(streamId) : undefined
    if (stream) {
      return {
        mode: 'fullscreen',
        contentMap: fullscreenViewContentMap(cols, rows, {
          url: stream.link,
          kind: stream.kind || 'video',
        }),
      }
    }
  }

  const contentMap: ViewContentMap = new Map()
  for (const [key, viewData] of viewsState) {
    const streamId = viewData.get('streamId')
    const stream = streamId != null ? byId.get(streamId) : undefined
    if (!stream) {
      continue
    }
    contentMap.set(key, {
      url: stream.link,
      kind: stream.kind || 'video',
    })
  }
  return {
    mode: 'normal',
    contentMap,
    clearedFullscreen: fullscreenViewIdx != null,
  }
}
