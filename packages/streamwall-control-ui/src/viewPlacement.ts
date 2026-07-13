import { range } from 'lodash-es'

/** A collaborative view cell as mirrored from the Yjs `views` map. */
interface ViewSlot {
  streamId: string | undefined
}

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
  focusedInputIdx: number | undefined
}): number | undefined {
  if (focusedInputIdx !== undefined) {
    return focusedInputIdx
  }
  return range(cellCount).find((idx) => !views[idx]?.streamId)
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
