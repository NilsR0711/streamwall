import { useCallback, useLayoutEffect, useState } from 'preact/hooks'
import { useHotkeys } from 'react-hotkeys-hook'
import * as Y from 'yjs'
import { isPrimaryButton } from './gestures'
import {
  computeKeyboardResizeHoverIdx,
  computeResizeAssignments,
  type ResizeHandle,
} from './gridInteractions'

interface CollabViews {
  views: { [viewIdx: string]: { streamId: string | undefined } }
}

/**
 * Manages the grid wall's tile-resize gesture: which tile (if any) is being
 * resized from which handle, and committing the resulting stream-id
 * reassignment into the shared Yjs `views` map. Takes `hoveringIdx` from
 * `useTileDrag` since the resize commit needs to know which cell the pointer
 * is over when it's released.
 */
export function useTileResize({
  cols,
  rows,
  hoveringIdx,
  stateDoc,
  sharedState,
}: {
  cols: number | null | undefined
  rows: number | null | undefined
  hoveringIdx: number | undefined
  stateDoc: Y.Doc
  sharedState: CollabViews | undefined
}) {
  const [resize, setResize] = useState<
    | {
        anchorIdx: number
        streamId: string
        handle: ResizeHandle
        originalSpaces: number[]
      }
    | undefined
  >()

  const handleResizeStart = useCallback(
    (
      anchorIdx: number,
      handle: ResizeHandle,
      originalSpaces: number[],
      ev: PointerEvent,
    ) => {
      if (!isPrimaryButton(ev.button)) {
        return
      }
      ev.preventDefault()
      ev.stopPropagation()
      const streamId = sharedState?.views?.[anchorIdx]?.streamId ?? undefined
      if (streamId == null || streamId === '') {
        return
      }
      setResize({ anchorIdx, streamId, handle, originalSpaces })
    },
    [sharedState],
  )

  // Keyboard equivalent of the pointer-drag resize above: each arrow-key
  // press commits a one-cell step immediately (there's no keyboard hover
  // state to preview), rather than opening an in-progress `resize` gesture.
  const handleResizeKeyDown = useCallback(
    (
      anchorIdx: number,
      handle: ResizeHandle,
      originalSpaces: number[],
      ev: KeyboardEvent,
    ) => {
      if (cols == null || rows == null) {
        return
      }
      const hoverIdx = computeKeyboardResizeHoverIdx(
        cols,
        rows,
        anchorIdx,
        handle,
        originalSpaces,
        ev.key,
      )
      if (hoverIdx == null) {
        return
      }
      ev.preventDefault()
      const streamId = sharedState?.views?.[anchorIdx]?.streamId ?? undefined
      if (streamId == null || streamId === '') {
        return
      }
      stateDoc.transact(() => {
        const viewsMap = stateDoc.getMap<Y.Map<string | undefined>>('views')
        const assignments = computeResizeAssignments(
          cols,
          anchorIdx,
          hoverIdx,
          streamId,
          handle,
          originalSpaces,
        )
        for (const [idx, assignedStreamId] of assignments) {
          viewsMap.get(String(idx))?.set('streamId', assignedStreamId)
        }
      })
    },
    [cols, rows, sharedState, stateDoc],
  )

  useLayoutEffect(() => {
    function endResize(ev: PointerEvent) {
      // A resize only commits while the pointer is over the grid; released
      // off-grid `hoveringIdx` is cleared, so this aborts instead of
      // snapping to a stale cell. A pointercancel likewise aborts.
      if (
        ev.type === 'pointercancel' ||
        resize == null ||
        cols == null ||
        rows == null ||
        hoveringIdx == null
      ) {
        setResize(undefined)
        return
      }
      stateDoc.transact(() => {
        const viewsMap = stateDoc.getMap<Y.Map<string | undefined>>('views')
        const assignments = computeResizeAssignments(
          cols,
          resize.anchorIdx,
          hoveringIdx,
          resize.streamId,
          resize.handle,
          resize.originalSpaces,
        )
        for (const [idx, streamId] of assignments) {
          viewsMap.get(String(idx))?.set('streamId', streamId)
        }
      })
      setResize(undefined)
    }
    window.addEventListener('pointerup', endResize)
    window.addEventListener('pointercancel', endResize)
    return () => {
      window.removeEventListener('pointerup', endResize)
      window.removeEventListener('pointercancel', endResize)
    }
  }, [resize, cols, rows, hoveringIdx, stateDoc])

  // Escape cancels an in-progress resize without committing. The window
  // pointerup/pointercancel listener above is a no-op once resize is
  // cleared.
  useHotkeys(
    `escape`,
    () => {
      setResize(undefined)
    },
    // Also fire while a grid input is focused during a gesture.
    { enableOnFormTags: true },
    [setResize],
  )

  return { resize, handleResizeStart, handleResizeKeyDown }
}
