import { range } from 'lodash-es'
import { asCellIdx, type CellIdx } from 'streamwall-shared'
import { type CollabData } from './collabData.ts'

/** A collaborative view cell as mirrored from the Yjs `views` map. */
type ViewSlot = CollabData['views'][string]

/**
 * Decide which grid cell a stream-id click should fill.
 *
 * When an input is focused the click targets that cell; otherwise it picks the
 * first empty cell (returning `undefined` when the grid is full). Reads the
 * views map defensively: right after a grid enlargement the JSON-config channel
 * can already report the larger grid while the Yjs `views` map still lacks
 * entries for the new cells, so a missing slot counts as empty instead of
 * throwing a `TypeError`.
 */
export function resolveTargetViewIdx({
  views,
  cellCount,
  focusedInputIdx,
}: {
  views: Record<string, ViewSlot | undefined>
  cellCount: number
  focusedInputIdx: CellIdx | undefined
}): CellIdx | undefined {
  if (focusedInputIdx !== undefined) {
    return focusedInputIdx
  }
  const emptyIdx = range(cellCount).find((idx) => !views[idx]?.streamId)
  return emptyIdx === undefined ? undefined : asCellIdx(emptyIdx)
}

/**
 * The cell index to read a rendered box's persisted stream assignment from.
 *
 * Normally a box's assignment lives at its top-left cell (`spaces[0]`). While a
 * view is expanded to fill the wall (issue #362) the single spanning box covers
 * every cell, but its stream is only recorded at the cell that was expanded, so
 * boxes covering the expanded cell resolve to `fullscreenViewIdx` instead. A
 * stale `fullscreenViewIdx` that no box covers is ignored, so an out-of-date
 * value never misattributes another box's stream.
 */
export function resolveAnchorIdx(
  spaces: CellIdx[],
  fullscreenViewIdx: CellIdx | null,
): CellIdx {
  if (fullscreenViewIdx != null && spaces.includes(fullscreenViewIdx)) {
    return fullscreenViewIdx
  }
  return spaces[0]
}

/**
 * The streamId to write into a view cell: the clicked id when it still exists
 * among the known streams, or `''` to clear the cell when it does not.
 *
 * Callers must pass the *current* streams — a stale list makes a freshly
 * appeared stream look unknown and would wrongly clear the cell instead of
 * placing the stream.
 */
export function resolveWriteStreamId(
  streams: readonly { _id: string }[],
  streamId: string,
): string {
  return streams.some((stream) => stream._id === streamId) ? streamId : ''
}

/**
 * The streamId to write for a per-keystroke (eager) input commit, or
 * `undefined` when the keystroke shouldn't commit at all.
 *
 * Unlike `resolveWriteStreamId`, an unmatched non-empty value returns
 * `undefined` rather than `''`: while typing a stream id character-by-
 * character, every partial value is technically "unknown" until the final
 * matching keystroke, and clearing the cell on each of those would tear
 * down the view mid-type. Only an explicitly emptied box (the user select-
 * all-deleted it) should clear the cell immediately.
 */
export function resolveEagerWriteStreamId(
  streams: readonly { _id: string }[],
  streamId: string,
): string | undefined {
  if (streamId === '') {
    return ''
  }
  const resolved = resolveWriteStreamId(streams, streamId)
  return resolved === '' ? undefined : resolved
}
