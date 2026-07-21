import { useCallback, useLayoutEffect, useState } from 'preact/hooks'
import { useHotkeys } from 'react-hotkeys-hook'
import {
  asCellIdx,
  roleCan,
  type CellIdx,
  type StreamwallRole,
} from 'streamwall-shared'
import * as Y from 'yjs'
import { type CollabData } from './collabData.ts'
import { isPrimaryButton } from './gestures'
import {
  computeKeyboardResizeHoverIdx,
  computeResizeAssignments,
  resizeWouldOverwriteOtherStream,
  type ResizeHandle,
} from './gridInteractions'

/** Snapshots a `CollabData.views` map into the `Map<idx, streamId>` shape `resizeWouldOverwriteOtherStream` expects. */
function collectCurrentAssignments(
  views: CollabData['views'] | undefined,
): Map<CellIdx, string | undefined> {
  const currentAssignments = new Map<CellIdx, string | undefined>()
  for (const [idx, view] of Object.entries(views ?? {})) {
    currentAssignments.set(asCellIdx(Number(idx)), view.streamId)
  }
  return currentAssignments
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
  role,
}: {
  cols: number | null | undefined
  rows: number | null | undefined
  hoveringIdx: CellIdx | undefined
  stateDoc: Y.Doc
  sharedState: CollabData | undefined
  role: StreamwallRole | null
}) {
  const [resize, setResize] = useState<
    | {
        anchorIdx: CellIdx
        streamId: string
        handle: ResizeHandle
        originalSpaces: CellIdx[]
      }
    | undefined
  >()

  const handleResizeStart = useCallback(
    (
      anchorIdx: CellIdx,
      handle: ResizeHandle,
      originalSpaces: CellIdx[],
      ev: PointerEvent,
    ) => {
      if (!isPrimaryButton(ev.button) || !roleCan(role, 'mutate-state-doc')) {
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
    [sharedState, role],
  )

  // Keyboard equivalent of the pointer-drag resize above: each arrow-key
  // press commits a one-cell step immediately (there's no keyboard hover
  // state to preview), rather than opening an in-progress `resize` gesture.
  // A step that would overwrite a neighbor's cells can't be gated behind the
  // pointer path's window.confirm (a dialog per keystroke would break the
  // interaction — see #327), so it's blocked as a no-op instead; holding
  // Shift explicitly overrides the block and commits the step anyway.
  const handleResizeKeyDown = useCallback(
    (
      anchorIdx: CellIdx,
      handle: ResizeHandle,
      originalSpaces: CellIdx[],
      ev: KeyboardEvent,
    ) => {
      if (cols == null || rows == null || !roleCan(role, 'mutate-state-doc')) {
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
      if (
        !ev.shiftKey &&
        resizeWouldOverwriteOtherStream(
          cols,
          anchorIdx,
          hoverIdx,
          streamId,
          handle,
          originalSpaces,
          collectCurrentAssignments(sharedState?.views),
        )
      ) {
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
    [cols, rows, sharedState, stateDoc, role],
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
      // Growing a tile over part of a neighbor silently claims those cells
      // and fragments the rest of the neighbor into smaller boxes — warn
      // before that happens, mirroring handleSetGridSize's confirm.
      if (
        resizeWouldOverwriteOtherStream(
          cols,
          resize.anchorIdx,
          hoveringIdx,
          resize.streamId,
          resize.handle,
          resize.originalSpaces,
          collectCurrentAssignments(sharedState?.views),
        ) &&
        !window.confirm(
          'Resizing this tile will overwrite part of another tile. Continue?',
        )
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
  }, [resize, cols, rows, hoveringIdx, stateDoc, sharedState])

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
