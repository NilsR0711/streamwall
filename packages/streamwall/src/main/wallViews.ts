import {
  type StreamList,
  type ViewContentMap,
  fullscreenViewContentMap,
} from 'streamwall-shared'
import * as Y from 'yjs'

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
  // Resolve cell assignments through the id index built alongside the stream
  // list (issue #628) instead of a per-cell linear scan; fall back to building
  // it here (still once per call) for lists that don't carry one.
  const streamsById =
    streams.byId ?? new Map(streams.map((stream) => [stream._id, stream]))
  const streamById = (streamId: string | undefined) =>
    streamId != null ? streamsById.get(streamId) : undefined

  if (fullscreenViewIdx != null) {
    const streamId = viewsState.get(String(fullscreenViewIdx))?.get('streamId')
    const stream = streamById(streamId)
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
    const stream = streamById(viewData.get('streamId'))
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
