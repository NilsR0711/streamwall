import { useCallback } from 'preact/hooks'
import {
  clampGridDimension,
  type ControlCommand,
  gridWouldDropAssignments,
  hasGridAssignments,
  type InvitableRole,
  type LocalStreamData,
  type StreamData,
} from 'streamwall-shared'
import * as Y from 'yjs'
import { copyTextToClipboard } from '../clipboard.ts'
import { type CollabData } from '../collabData.ts'
import { type Invite, parseInviteResponse } from '../invite.ts'
import {
  resolveEagerWriteStreamId,
  resolveTargetViewIdx,
} from '../viewPlacement.ts'

/**
 * The imperative command layer for ControlUI: every wrapper that dispatches a
 * `ControlCommand` through `send` or mutates the shared views doc. Grouping
 * them here keeps the composition root free of dispatch logic and makes the
 * command handlers unit-testable in isolation with a mock `send` (issue #393).
 *
 * The two grid-shrinking guards (`handleSetGridSize`, `handleLoadLayoutPreset`)
 * intentionally still call `window.confirm` before a destructive change, and
 * `handleClickId`/`handleCreateInvite` reach out to the clipboard and invite
 * parser exactly as they did inline — behavior is unchanged.
 */
export function useGridCommands({
  send,
  streams,
  sharedState,
  stateDoc,
  cols,
  rows,
  fullscreenViewIdx,
  focusedInputIdx,
  favoritesSet,
  onInvite,
  onError,
}: {
  send: (msg: ControlCommand, cb?: (msg: unknown) => void) => void
  streams: StreamData[]
  sharedState: CollabData | undefined
  stateDoc: Y.Doc
  cols: number | null
  rows: number | null
  fullscreenViewIdx: number | null
  focusedInputIdx: number | undefined
  favoritesSet: ReadonlySet<string>
  onInvite: (invite: Invite) => void
  onError: (message: string) => void
}) {
  const handleSetView = useCallback(
    (idx: number, streamId: string) => {
      const resolved = resolveEagerWriteStreamId(streams, streamId)
      if (resolved === undefined) {
        return
      }
      stateDoc
        .getMap<Y.Map<string | undefined>>('views')
        .get(String(idx))
        ?.set('streamId', resolved)
    },
    [stateDoc, streams],
  )

  const handleSetListening = useCallback(
    (viewId: number, listening: boolean) => {
      send({
        type: 'set-listening-view',
        viewId: listening ? viewId : null,
      })
    },
    [send],
  )

  // Double-clicking a stream tile expands it to fill the whole wall; double-
  // clicking again (any tile, since only the expanded one is shown) collapses
  // back to the grid. Purely runtime state -- the persisted layout is untouched
  // (issue #362).
  const handleToggleFullscreen = useCallback(
    (viewId: number) => {
      send({
        type: 'set-view-fullscreen',
        viewId,
        fullscreen: fullscreenViewIdx == null,
      })
    },
    [send, fullscreenViewIdx],
  )

  const handleSetGridSize = useCallback(
    (nextCols: number, nextRows: number) => {
      const targetCols = clampGridDimension(nextCols)
      const targetRows = clampGridDimension(nextRows)
      // Shrinking the grid permanently drops any placement whose (x, y) no
      // longer fits. Warn before that happens so it is never silent.
      if (cols != null && sharedState) {
        const assignments = new Map<number, string | undefined>()
        for (const [idx, view] of Object.entries(sharedState.views)) {
          assignments.set(Number(idx), view.streamId)
        }
        if (
          gridWouldDropAssignments(cols, targetCols, targetRows, assignments) &&
          !window.confirm(
            'The new grid is smaller and will permanently remove occupied tiles. Continue?',
          )
        ) {
          return
        }
      }
      send({
        type: 'set-grid-size',
        cols: targetCols,
        rows: targetRows,
      })
    },
    [send, cols, sharedState],
  )

  const handleSetBackgroundListening = useCallback(
    (viewId: number, listening: boolean) => {
      send({
        type: 'set-view-background-listening',
        viewId,
        listening,
      })
    },
    [send],
  )

  const handleSetBlurred = useCallback(
    (viewId: number, blurred: boolean) => {
      send({
        type: 'set-view-blurred',
        viewId,
        blurred,
      })
    },
    [send],
  )

  const handleSetVolume = useCallback(
    (viewId: number, volume: number) => {
      send({
        type: 'set-view-volume',
        viewId,
        volume,
      })
    },
    [send],
  )

  const handleReloadView = useCallback(
    (viewId: number) => {
      send({
        type: 'reload-view',
        viewId,
      })
    },
    [send],
  )

  const handleRotateStream = useCallback(
    (streamId: string) => {
      const stream = streams.find((d) => d._id === streamId)
      if (!stream) {
        return
      }
      send({
        type: 'rotate-stream',
        url: stream.link,
        rotation: ((stream.rotation || 0) + 90) % 360,
      })
    },
    [streams, send],
  )

  const handleBrowse = useCallback(
    (streamId: string) => {
      const stream = streams.find((d) => d._id === streamId)
      if (!stream) {
        return
      }
      send({
        type: 'browse',
        url: stream.link,
      })
    },
    [streams, send],
  )

  const handleDevTools = useCallback(
    (viewId: number) => {
      send({
        type: 'dev-tools',
        viewId,
      })
    },
    [send],
  )

  const handleClickId = useCallback(
    (streamId: string) => {
      if (cols == null || rows == null || sharedState == null) {
        return
      }

      copyTextToClipboard(streamId)

      const targetIdx = resolveTargetViewIdx({
        views: sharedState.views,
        cellCount: cols * rows,
        focusedInputIdx,
      })
      if (targetIdx === undefined) {
        return
      }
      handleSetView(targetIdx, streamId)
    },
    [cols, rows, sharedState, focusedInputIdx, handleSetView],
  )

  const handleChangeCustomStream = useCallback(
    (url: string, customStream: LocalStreamData) => {
      send({
        type: 'update-custom-stream',
        url,
        data: customStream,
      })
    },
    [send],
  )

  const handleDeleteCustomStream = useCallback(
    (url: string) => {
      send({
        type: 'delete-custom-stream',
        url,
      })
      return
    },
    [send],
  )

  const setStreamCensored = useCallback(
    (isCensored: boolean) => {
      send({
        type: 'set-stream-censored',
        isCensored,
      })
    },
    [send],
  )

  const setStreamRunning = useCallback(
    (isStreamRunning: boolean) => {
      send({
        type: 'set-stream-running',
        isStreamRunning,
      })
    },
    [send],
  )

  const handleCreateInvite = useCallback(
    ({ name, role }: { name: string; role: InvitableRole }) => {
      send(
        {
          type: 'create-invite',
          name,
          role,
        },
        (msg) => {
          const invite = parseInviteResponse(msg)
          if (!invite) {
            onError('Received a malformed invite response from the server')
            return
          }
          onInvite(invite)
        },
      )
    },
    [send, onError, onInvite],
  )

  const handleDeleteToken = useCallback(
    (tokenId: string) => {
      send({
        type: 'delete-token',
        tokenId,
      })
    },
    [send],
  )

  const handleSaveLayoutPreset = useCallback(
    (name: string) => {
      send({ type: 'save-layout-preset', name })
    },
    [send],
  )

  const handleLoadLayoutPreset = useCallback(
    (presetId: string) => {
      // Loading a preset unconditionally replaces every cell (see
      // applyLayoutPreset), unlike a grid resize which only drops cells that
      // fall outside the new bounds. So warn whenever the current layout has
      // any live assignment, mirroring handleSetGridSize's confirm above.
      if (sharedState) {
        const assignments = new Map<number, string | undefined>()
        for (const [idx, view] of Object.entries(sharedState.views)) {
          assignments.set(Number(idx), view.streamId)
        }
        if (
          hasGridAssignments(assignments) &&
          !window.confirm(
            'Loading this preset will replace the current layout. Save it as a preset first if you want to keep it. Continue?',
          )
        ) {
          return
        }
      }
      send({ type: 'load-layout-preset', presetId })
    },
    [send, sharedState],
  )

  const handleDeleteLayoutPreset = useCallback(
    (presetId: string) => {
      send({ type: 'delete-layout-preset', presetId })
    },
    [send],
  )

  const handleToggleFavorite = useCallback(
    (url: string) => {
      if (favoritesSet.has(url)) {
        send({ type: 'remove-favorite', url })
      } else {
        send({ type: 'add-favorite', url })
      }
    },
    [send, favoritesSet],
  )

  return {
    handleSetView,
    handleSetListening,
    handleToggleFullscreen,
    handleSetGridSize,
    handleSetBackgroundListening,
    handleSetBlurred,
    handleSetVolume,
    handleReloadView,
    handleRotateStream,
    handleBrowse,
    handleDevTools,
    handleClickId,
    handleChangeCustomStream,
    handleDeleteCustomStream,
    setStreamCensored,
    setStreamRunning,
    handleCreateInvite,
    handleDeleteToken,
    handleSaveLayoutPreset,
    handleLoadLayoutPreset,
    handleDeleteLayoutPreset,
    handleToggleFavorite,
  }
}
