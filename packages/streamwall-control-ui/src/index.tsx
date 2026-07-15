import '@fontsource/noto-sans'
// Design system fonts (bundled so they work under the strict app CSP).
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/700.css'
import '@fontsource/oswald/600.css'
import '@fontsource/saira-stencil-one'
import { orderBy, range } from 'lodash-es'
import { DateTime } from 'luxon'
import { type JSX } from 'preact'
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks'
import { useHotkeys } from 'react-hotkeys-hook'
import {
  clampGridDimension,
  type ControlCommand,
  type DataSourceHealth,
  type DisconnectReason,
  gridWouldDropAssignments,
  hasGridAssignments,
  idColor,
  inviteLink,
  type LayoutPreset,
  type LocalStreamData,
  roleCan,
  type StreamData,
  type StreamDelayStatus,
  type StreamwallRole,
  type StreamwallState,
  type StreamWindowConfig,
  type ViewState,
} from 'streamwall-shared'
import { styled } from 'styled-components'
import { matchesState } from 'xstate'
import * as Y from 'yjs'
import { AuthTokenLine, CreateInviteInput } from './AccessPanel.tsx'
import { copyTextToClipboard } from './clipboard.ts'
import { type CollabData } from './collabData.ts'
import { createErrorSurfacingSend } from './commandError.ts'
import { CommandErrorBanner } from './CommandErrorBanner.tsx'
import { ConnectionStatusBanner } from './ConnectionStatusBanner.tsx'
import { DataSourceHealthBanner } from './DataSourceHealthBanner.tsx'
import { ThemeToggle } from './globalStyle.tsx'
import { GridControls } from './GridControls.tsx'
import { GridInput } from './GridInput.tsx'
import { isIdxInResizeBox } from './gridInteractions'
import { GridPreviewBox } from './GridPreviewBox.tsx'
import { GridSizeControls } from './GridSizeControls.tsx'
import {
  blurHotkeyLayerBindings,
  hotkeyLayerBindings,
  hotkeyTriggers,
} from './hotkeyLabel.ts'
import './index.css'
import { type Invite, parseInviteResponse } from './invite.ts'
import { LayoutPresetControls } from './LayoutPresetControls.tsx'
import { ResizeHandles } from './ResizeHandles.tsx'
import {
  CreateCustomStreamInput,
  CustomStreamInput,
  StreamList,
} from './Sidebar.tsx'
import { StyledButton, StyledDataContainer } from './StyledButton.tsx'
import { useTileDrag } from './useTileDrag.ts'
import { useTileResize } from './useTileResize.ts'
import {
  resolveEagerWriteStreamId,
  resolveTargetViewIdx,
} from './viewPlacement.ts'

// Re-exported for `streamwall-control-client` and `streamwall`'s renderer,
// which mount it alongside `<ControlUI>` — its implementation now lives in
// `./globalStyle.tsx` alongside the theme tokens it applies.
export { GlobalStyle } from './globalStyle.tsx'

export interface ViewInfo {
  state: ViewState
  isListening: boolean
  isBackgroundListening: boolean
  isBlurred: boolean
  volume: number
  spaces: number[]
}

const normalStreamKinds = new Set(['video', 'audio', 'web'])
function filterStreams(
  streams: StreamData[],
  wallStreamIds: Set<string>,
  favoriteLinks: ReadonlySet<string>,
  filter: string,
) {
  const wallStreams = []
  const liveStreams = []
  const otherStreams = []
  const favoriteStreams = []
  for (const stream of streams) {
    const { _id, kind, status, label, source, state, city, link } = stream
    if (kind && !normalStreamKinds.has(kind)) {
      continue
    }
    if (
      filter !== '' &&
      !`${label}${source}${state}${city}`
        .toLowerCase()
        .includes(filter.toLowerCase())
    ) {
      continue
    }
    if (favoriteLinks.has(link)) {
      favoriteStreams.push(stream)
    }
    if (wallStreamIds.has(_id)) {
      wallStreams.push(stream)
    } else if ((kind && kind !== 'video') || status === 'Live') {
      liveStreams.push(stream)
    } else {
      otherStreams.push(stream)
    }
  }
  return [wallStreams, liveStreams, otherStreams, favoriteStreams]
}

export { collabDataSchema, type CollabData } from './collabData.ts'
export { useYDoc } from './useYDoc.ts'

export interface StreamwallConnection {
  isConnected: boolean
  /**
   * Why the websocket is currently closed, when the server said so before
   * closing it. `undefined`/`null` while connected, or while disconnected
   * for an unexplained reason (network blip, generic retry).
   */
  disconnectReason?: DisconnectReason | null
  role: StreamwallRole | null
  send: (msg: ControlCommand, cb?: (msg: unknown) => void) => void
  sharedState: CollabData | undefined
  stateDoc: Y.Doc
  undoManager?: Y.UndoManager
  config: StreamWindowConfig | undefined
  streams: StreamData[]
  customStreams: StreamData[]
  views: ViewInfo[]
  stateIdxMap: Map<number, ViewInfo>
  delayState: StreamDelayStatus | null | undefined
  authState?: StreamwallState['auth']
  layoutPresets: LayoutPreset[]
  favorites: string[]
  dataSourceHealth: DataSourceHealth[]
}

export function useStreamwallState(state: StreamwallState | undefined) {
  return useMemo(() => {
    if (state === undefined) {
      return {
        role: null,
        config: undefined,
        streams: [],
        customStreams: [],
        views: [],
        stateIdxMap: new Map(),
        delayState: undefined,
        authState: undefined,
        layoutPresets: [],
        favorites: [],
        dataSourceHealth: [],
      }
    }

    const {
      identity: { role },
      auth,
      config,
      streams: stateStreams,
      views: stateViews,
      streamdelay,
      layoutPresets,
      favorites,
      dataSourceHealth,
    } = state
    const stateIdxMap = new Map()
    const views = []
    for (const viewState of stateViews) {
      const { pos } = viewState.context
      const isListening = matchesState(
        'displaying.running.audio.listening',
        viewState.state,
      )
      const isBackgroundListening = matchesState(
        'displaying.running.audio.background',
        viewState.state,
      )
      const isBlurred = matchesState(
        'displaying.running.video.blurred',
        viewState.state,
      )
      const spaces = pos?.spaces ?? []
      const viewInfo = {
        state: viewState,
        isListening,
        isBackgroundListening,
        isBlurred,
        volume: viewState.context.volume,
        spaces,
      }
      views.push(viewInfo)
      for (const space of spaces) {
        if (!stateIdxMap.has(space)) {
          stateIdxMap.set(space, {})
        }
        Object.assign(stateIdxMap.get(space), viewInfo)
      }
    }

    const streams = orderBy(stateStreams, ['addedDate', '_id'], ['desc', 'asc'])
    const customStreams = stateStreams.filter((s) => s._dataSource === 'custom')

    return {
      role,
      authState: auth,
      delayState: streamdelay,
      views,
      config,
      streams,
      customStreams,
      stateIdxMap,
      layoutPresets,
      favorites,
      dataSourceHealth,
    }
  }, [state])
}

export function ControlUI({
  connection,
}: {
  connection: StreamwallConnection
}) {
  const {
    isConnected,
    disconnectReason,
    send: connectionSend,
    sharedState,
    stateDoc,
    undoManager,
    config,
    streams,
    customStreams,
    views,
    stateIdxMap,
    delayState,
    authState,
    role,
    layoutPresets,
    favorites,
    dataSourceHealth,
  } = connection
  const {
    cols,
    rows,
    width: windowWidth,
    height: windowHeight,
  } = config ?? { cols: null, rows: null, width: null, height: null }

  // Surfaces `{ error }` command responses that would otherwise be dropped
  // silently by the many call sites below that don't pass their own
  // response callback (issue #35).
  const [commandError, setCommandError] = useState<string | null>(null)
  const send = useMemo(
    () => createErrorSurfacingSend(connectionSend, setCommandError),
    [connectionSend],
  )

  const [showDebug, setShowDebug] = useState(false)
  const handleChangeShowDebug = useCallback<
    JSX.InputEventHandler<HTMLInputElement>
  >((ev) => {
    setShowDebug(ev.currentTarget.checked)
  }, [])

  const {
    hoveringIdx,
    swapStartIdx,
    moveStart,
    moveTargetIdx,
    updateHoveringIdx,
    clearHoveringIdx,
    handleSwapView,
    handleGridPointerDown,
  } = useTileDrag({ cols, rows, stateDoc, stateIdxMap, role })
  const { resize, handleResizeStart, handleResizeKeyDown } = useTileResize({
    cols,
    rows,
    hoveringIdx,
    stateDoc,
    sharedState,
    role,
  })

  const [focusedInputIdx, setFocusedInputIdx] = useState<number | undefined>()
  const handleBlurInput = useCallback(() => setFocusedInputIdx(undefined), [])

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
    (idx: number, listening: boolean) => {
      send({
        type: 'set-listening-view',
        viewIdx: listening ? idx : null,
      })
    },
    [send],
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
    (viewIdx: number, listening: boolean) => {
      send({
        type: 'set-view-background-listening',
        viewIdx,
        listening,
      })
    },
    [send],
  )

  const handleSetBlurred = useCallback(
    (viewIdx: number, blurred: boolean) => {
      send({
        type: 'set-view-blurred',
        viewIdx,
        blurred,
      })
    },
    [send],
  )

  const handleSetVolume = useCallback(
    (viewIdx: number, volume: number) => {
      send({
        type: 'set-view-volume',
        viewIdx,
        volume,
      })
    },
    [send],
  )

  const handleReloadView = useCallback(
    (viewIdx: number) => {
      send({
        type: 'reload-view',
        viewIdx,
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
    (viewIdx: number) => {
      send({
        type: 'dev-tools',
        viewIdx,
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

  const [newInvite, setNewInvite] = useState<Invite>()

  const handleCreateInvite = useCallback(
    ({ name, role }: { name: string; role: StreamwallRole }) => {
      send(
        {
          type: 'create-invite',
          name,
          role,
        },
        (msg) => {
          const invite = parseInviteResponse(msg)
          if (!invite) {
            setCommandError(
              'Received a malformed invite response from the server',
            )
            return
          }
          setNewInvite(invite)
        },
      )
    },
    [send, setCommandError],
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

  const favoritesSet = useMemo(() => new Set(favorites), [favorites])

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

  const preventLinkClick = useCallback((ev: Event) => {
    ev.preventDefault()
  }, [])

  const [streamFilter, setStreamFilter] = useState('')
  const handleStreamFilterChange = useCallback<
    JSX.InputEventHandler<HTMLInputElement>
  >((ev) => {
    setStreamFilter(ev.currentTarget?.value)
  }, [])

  // Set up keyboard shortcuts.
  const toggleListening = useCallback(
    (idx: number) => {
      const isListening = stateIdxMap.get(idx)?.isListening ?? false
      handleSetListening(idx, !isListening)
    },
    [stateIdxMap, handleSetListening],
  )
  // Audio-listen toggle, layer 0: alt+<key> -> cells 0-19. `enableOnFormTags`
  // keeps the hotkey live while a grid input is focused.
  useHotkeys(
    hotkeyLayerBindings[0],
    (ev, { hotkey }) => {
      ev.preventDefault()
      toggleListening(hotkeyTriggers.indexOf(hotkey[hotkey.length - 1]))
    },
    { enableOnFormTags: true },
    [toggleListening],
  )
  // Audio-listen toggle, layer 1: alt+ctrl+<key> -> cells 20-39 (see
  // `hotkeyLayers`). Same trigger keys, offset by one layer of 20 cells.
  useHotkeys(
    hotkeyLayerBindings[1],
    (ev, { hotkey }) => {
      ev.preventDefault()
      toggleListening(
        hotkeyTriggers.length +
          hotkeyTriggers.indexOf(hotkey[hotkey.length - 1]),
      )
    },
    { enableOnFormTags: true },
    [toggleListening],
  )
  const toggleBlurred = useCallback(
    (idx: number) => {
      const isBlurred = stateIdxMap.get(idx)?.isBlurred ?? false
      handleSetBlurred(idx, !isBlurred)
    },
    [stateIdxMap, handleSetBlurred],
  )
  // Blur toggle, layer 0: alt+shift+<key> -> cells 0-19.
  useHotkeys(
    blurHotkeyLayerBindings[0],
    (ev, { hotkey }) => {
      ev.preventDefault()
      toggleBlurred(hotkeyTriggers.indexOf(hotkey[hotkey.length - 1]))
    },
    [toggleBlurred],
  )
  // Blur toggle, layer 1: alt+ctrl+shift+<key> -> cells 20-39 (see
  // `blurHotkeyLayers`). Same trigger keys, offset by one layer of 20 cells.
  useHotkeys(
    blurHotkeyLayerBindings[1],
    (ev, { hotkey }) => {
      ev.preventDefault()
      toggleBlurred(
        hotkeyTriggers.length +
          hotkeyTriggers.indexOf(hotkey[hotkey.length - 1]),
      )
    },
    [toggleBlurred],
  )
  useHotkeys(
    `alt+c`,
    () => {
      setStreamCensored(true)
    },
    [setStreamCensored],
  )
  useHotkeys(
    `alt+shift+c`,
    () => {
      setStreamCensored(false)
    },
    [setStreamCensored],
  )
  useHotkeys(
    `alt+s`,
    () => {
      if (focusedInputIdx != null && roleCan(role, 'mutate-state-doc')) {
        handleSwapView(focusedInputIdx)
      }
    },
    [handleSwapView, focusedInputIdx, role],
  )
  // Undo/redo edits to the shared views doc (drag-move, swap, and destructive
  // grid-shrink remaps alike - see `useYDoc`'s `remoteOrigin` wiring).
  // `enableOnFormTags` defaults to false so this doesn't hijack native
  // undo/redo while a text input (e.g. a grid-size field) is focused.
  useHotkeys(
    'mod+z',
    (ev) => {
      ev.preventDefault()
      undoManager?.undo()
    },
    [undoManager],
  )
  useHotkeys(
    'mod+shift+z',
    (ev) => {
      ev.preventDefault()
      undoManager?.redo()
    },
    [undoManager],
  )

  const wallStreamIds = useMemo(
    () =>
      new Set(
        Object.values(sharedState?.views ?? {})
          .map(({ streamId }) => streamId)
          .filter((x) => x !== undefined),
      ),
    [sharedState],
  )
  const [wallStreams, liveStreams, otherStreams, favoriteStreams] = useMemo(
    () => filterStreams(streams, wallStreamIds, favoritesSet, streamFilter),
    [streams, wallStreamIds, favoritesSet, streamFilter],
  )
  const toggleFavoriteHandler = roleCan(role, 'add-favorite')
    ? handleToggleFavorite
    : undefined
  return (
    <AppShell className="app-shell">
      <Stack className="grid-container">
        <StyledHeader>
          <div className="wm">
            STREAM<span>·</span>WALL
          </div>
          <div className="crumbs">
            //&nbsp; <b>Multiview</b> &nbsp;·&nbsp; {cols}×{rows}
          </div>
          {cols != null && rows != null && (
            <GridSizeControls
              cols={cols}
              rows={rows}
              role={role}
              onSetGridSize={handleSetGridSize}
            />
          )}
          <LayoutPresetControls
            presets={layoutPresets}
            role={role}
            onSavePreset={handleSaveLayoutPreset}
            onLoadPreset={handleLoadLayoutPreset}
            onDeletePreset={handleDeleteLayoutPreset}
          />
          <div className="spacer" />
          {liveStreams.length > 0 && (
            <div className="livecount">● {liveStreams.length} On Air</div>
          )}
          {role !== 'local' && (
            <div className="status" data-testid="header-connection-status">
              <span className={`dot ${isConnected ? 'on' : 'off'}`} />
              {isConnected ? 'connected' : 'connecting...'} · {role}
            </div>
          )}
          <ThemeToggle />
        </StyledHeader>
        <ConnectionStatusBanner
          isConnected={isConnected}
          reason={disconnectReason}
        />
        <DataSourceHealthBanner dataSourceHealth={dataSourceHealth} />
        <CommandErrorBanner
          error={commandError}
          onDismiss={() => setCommandError(null)}
        />
        {delayState && (
          <StreamDelayBox
            role={role}
            delayState={delayState}
            setStreamCensored={setStreamCensored}
            setStreamRunning={setStreamRunning}
          />
        )}
        <StyledDataContainer
          $isConnected={isConnected}
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
          }}
        >
          {cols != null && rows != null && (
            <StyledGridContainer
              className="grid"
              data-testid="grid"
              onPointerMove={updateHoveringIdx}
              onPointerLeave={clearHoveringIdx}
              $windowWidth={windowWidth}
              $windowHeight={windowHeight}
            >
              <StyledGridInputs>
                {range(0, rows).map((y) =>
                  range(0, cols).map((x) => {
                    const idx = cols * y + x
                    const { streamId } = sharedState?.views?.[idx] ?? {}
                    const isMoveHighlight =
                      moveStart != null &&
                      moveTargetIdx != null &&
                      moveStart.idx !== moveTargetIdx &&
                      (
                        stateIdxMap.get(moveTargetIdx)?.spaces ?? [
                          moveTargetIdx,
                        ]
                      ).includes(idx)
                    const isResizeHighlight =
                      resize != null &&
                      hoveringIdx != null &&
                      isIdxInResizeBox(
                        cols,
                        resize.anchorIdx,
                        hoveringIdx,
                        resize.handle,
                        resize.originalSpaces,
                        idx,
                      )
                    const isHighlighted = isMoveHighlight || isResizeHighlight
                    return (
                      <GridInput
                        key={idx}
                        style={{
                          width: `${100 / cols}%`,
                          height: `${100 / rows}%`,
                          left: `${(100 * x) / cols}%`,
                          top: `${(100 * y) / rows}%`,
                        }}
                        idx={idx}
                        spaceValue={streamId ?? ''}
                        onChangeSpace={handleSetView}
                        isHighlighted={isHighlighted}
                        role={role}
                        onPointerDown={handleGridPointerDown}
                        onFocus={setFocusedInputIdx}
                        onBlur={handleBlurInput}
                      />
                    )
                  }),
                )}
              </StyledGridInputs>
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  pointerEvents: 'none',
                }}
              >
                {views.map(({ state }) => {
                  const { pos } = state.context
                  if (pos == null) {
                    return null
                  }
                  const anchorIdx = Math.min(...pos.spaces)
                  return (
                    <div
                      key={`rh-${anchorIdx}`}
                      style={{
                        position: 'absolute',
                        left: `${(100 * pos.x) / windowWidth}%`,
                        top: `${(100 * pos.y) / windowHeight}%`,
                        width: `${(100 * pos.width) / windowWidth}%`,
                        height: `${(100 * pos.height) / windowHeight}%`,
                        pointerEvents: 'none',
                      }}
                    >
                      <ResizeHandles
                        anchorIdx={anchorIdx}
                        originalSpaces={pos.spaces}
                        role={role}
                        onResizeStart={handleResizeStart}
                        onResizeKeyDown={handleResizeKeyDown}
                      />
                    </div>
                  )
                })}
              </div>
              <StyledGridPreview>
                {views.map(({ state, isListening }) => {
                  const { pos } = state.context
                  if (pos == null) {
                    return null
                  }

                  const { streamId } = sharedState?.views[pos.spaces[0]] ?? {}
                  const data = streams.find((d) => d._id === streamId)
                  if (streamId == null || data == null) {
                    return null
                  }

                  const isSmall = pos.height < 200
                  const isError = matchesState('displaying.error', state.state)
                  const errorReason = state.context.error
                  return (
                    <GridPreviewBox
                      key={pos.spaces[0]}
                      streamId={streamId}
                      color={idColor(streamId)}
                      style={{
                        left: `${(100 * pos.x) / windowWidth}%`,
                        top: `${(100 * pos.y) / windowHeight}%`,
                        width: `${(100 * pos.width) / windowWidth}%`,
                        height: `${(100 * pos.height) / windowHeight}%`,
                      }}
                      pos={pos}
                      windowWidth={windowWidth}
                      windowHeight={windowHeight}
                      isListening={isListening}
                      isSmall={isSmall}
                      isError={isError}
                      errorReason={errorReason}
                      orientation={data?.orientation ?? null}
                      source={data?.source}
                      city={data?.city}
                      state={data?.state}
                    />
                  )
                })}
              </StyledGridPreview>
              {views.map(
                ({
                  state,
                  isListening,
                  isBackgroundListening,
                  isBlurred,
                  volume,
                }) => {
                  const { pos } = state.context
                  if (!pos) {
                    return null
                  }
                  const { streamId } = sharedState?.views[pos.spaces[0]] ?? {}
                  if (!streamId) {
                    return null
                  }
                  return (
                    <GridControls
                      key={pos.spaces[0]}
                      idx={pos.spaces[0]}
                      streamId={streamId}
                      style={{
                        left: `${(100 * pos.x) / windowWidth}%`,
                        top: `${(100 * pos.y) / windowHeight}%`,
                        width: `${(100 * pos.width) / windowWidth}%`,
                        height: `${(100 * pos.height) / windowHeight}%`,
                      }}
                      isDisplaying={matchesState('displaying', state.state)}
                      isListening={isListening}
                      isBackgroundListening={isBackgroundListening}
                      isBlurred={isBlurred}
                      volume={volume}
                      isSwapping={
                        swapStartIdx != null &&
                        pos.spaces.includes(swapStartIdx)
                      }
                      showDebug={showDebug}
                      role={role}
                      onSetListening={handleSetListening}
                      onSetBackgroundListening={handleSetBackgroundListening}
                      onSetBlurred={handleSetBlurred}
                      onSetVolume={handleSetVolume}
                      onReloadView={handleReloadView}
                      onSwapView={handleSwapView}
                      onRotateView={handleRotateStream}
                      onBrowse={handleBrowse}
                      onDevTools={handleDevTools}
                      onPointerDown={handleGridPointerDown}
                    />
                  )
                },
              )}
            </StyledGridContainer>
          )}
        </StyledDataContainer>
        <StyledStatusBar>
          {(roleCan(role, 'dev-tools') || roleCan(role, 'browse')) && (
            <label className="dbg">
              <input
                type="checkbox"
                checked={showDebug}
                onChange={handleChangeShowDebug}
              />
              Debug-Tools
            </label>
          )}
          <span className="spacer" />
          <span className="meta">
            {streams.length} Quellen · {liveStreams.length} live
          </span>
        </StyledStatusBar>
      </Stack>
      <Stack className="stream-list" $scroll={true} $minHeight={200}>
        {
          // Keyed on `role` (persists across a reconnect, see
          // `StreamwallConnection`) rather than `isConnected`, so a brief
          // disconnect dims the last-known list instead of replacing it with
          // "loading..." (issue #37). Only the very first load, before any
          // state has ever arrived, shows the loading placeholder.
        }
        <StyledDataContainer $isConnected={isConnected}>
          {role != null ? (
            <div>
              <input
                className="filter-input"
                onChange={handleStreamFilterChange}
                value={streamFilter}
                placeholder="Filter streams…"
              />
              <h3>
                Favorites <span className="ct">{favoriteStreams.length}</span>
              </h3>
              <StreamList
                rows={favoriteStreams}
                disabled={!roleCan(role, 'mutate-state-doc')}
                onClickId={handleClickId}
                favorites={favoritesSet}
                onToggleFavorite={toggleFavoriteHandler}
              />
              <h3>
                Viewing <span className="ct">{wallStreams.length}</span>
              </h3>
              <StreamList
                rows={wallStreams}
                disabled={!roleCan(role, 'mutate-state-doc')}
                onClickId={handleClickId}
                favorites={favoritesSet}
                onToggleFavorite={toggleFavoriteHandler}
              />
              <h3>
                Live <span className="ct">{liveStreams.length}</span>
              </h3>
              <StreamList
                rows={liveStreams}
                disabled={!roleCan(role, 'mutate-state-doc')}
                onClickId={handleClickId}
                favorites={favoritesSet}
                onToggleFavorite={toggleFavoriteHandler}
              />
              <h3>
                Offline / Unknown{' '}
                <span className="ct">{otherStreams.length}</span>
              </h3>
              <StreamList
                rows={otherStreams}
                disabled={!roleCan(role, 'mutate-state-doc')}
                onClickId={handleClickId}
                favorites={favoritesSet}
                onToggleFavorite={toggleFavoriteHandler}
              />
            </div>
          ) : (
            <div>loading...</div>
          )}
          {roleCan(role, 'update-custom-stream') &&
            roleCan(role, 'delete-custom-stream') && (
              <>
                <h2>Custom Streams</h2>
                <div>
                  {/*
                    Keyed by `link` (each custom stream's stable id) rather
                    than array index, so deleting an earlier entry doesn't
                    shift later entries onto a different DOM node mid-edit.
                  */}
                  {customStreams.map(({ link, label, kind }) => (
                    <CustomStreamInput
                      key={link}
                      link={link}
                      label={label}
                      kind={kind}
                      onChange={handleChangeCustomStream}
                      onDelete={handleDeleteCustomStream}
                    />
                  ))}
                  <CreateCustomStreamInput
                    onCreate={handleChangeCustomStream}
                  />
                </div>
              </>
            )}
          {(roleCan(role, 'create-invite') || roleCan(role, 'delete-token')) &&
            authState && (
              <>
                <h2>Access</h2>
                <div>
                  <CreateInviteInput onCreateInvite={handleCreateInvite} />
                  <h3>Invites</h3>
                  {newInvite && (
                    <StyledNewInviteBox>
                      Invite link created:{' '}
                      <a
                        href={inviteLink({
                          tokenId: newInvite.tokenId,
                          secret: newInvite.secret,
                        })}
                        onClick={preventLinkClick}
                      >
                        "{newInvite.name}"
                      </a>
                    </StyledNewInviteBox>
                  )}
                  {authState.invites.map(({ tokenId, name, role }) => (
                    <AuthTokenLine
                      key={tokenId}
                      id={tokenId}
                      name={name}
                      role={role}
                      onDelete={handleDeleteToken}
                    />
                  ))}
                  <h3>Sessions</h3>
                  {authState.sessions.map(({ tokenId, name, role }) => (
                    <AuthTokenLine
                      key={tokenId}
                      id={tokenId}
                      name={name}
                      role={role}
                      onDelete={handleDeleteToken}
                    />
                  ))}
                </div>
              </>
            )}
        </StyledDataContainer>
      </Stack>
    </AppShell>
  )
}

const Stack = styled.div<{
  $direction?: string
  $flex?: string
  $gap?: number
  $scroll?: boolean
  $minHeight?: number
}>`
  display: flex;
  flex-direction: ${({ $direction }) => $direction ?? 'column'};
  flex: ${({ $flex }) => $flex};
  ${({ $gap }) => $gap && `gap: ${$gap}px`};
  ${({ $scroll }) => $scroll && `overflow-y: auto`};
  ${({ $minHeight }) => $minHeight && `min-height: ${$minHeight}px`};
`

// Below this viewport width the side-by-side wall/stream-list layout stops
// fitting, so the shell stacks the two regions vertically instead (see #81).
// Shared with the header so both switch to their narrow layout together.
const NARROW_BREAKPOINT = 820

// Root layout. Desktop: the wall preview and the stream list sit side by side,
// pinned to the viewport height with only the stream list scrolling. Narrow
// screens (phones, small windows): the two regions stack and the whole page
// scrolls. Layout that the media query needs to override lives here rather than
// as inline styles on the children so the cascade can win cleanly.
const AppShell = styled.div`
  display: flex;
  flex: 1;
  flex-direction: row;
  gap: 16px;
  height: 100vh;
  min-height: 0;
  padding: 16px;
  overflow: hidden;

  > .grid-container {
    flex: 1;
    min-width: 0;
    min-height: 0;
  }

  > .stream-list {
    flex: 0 0 340px;
  }

  @media (max-width: ${NARROW_BREAKPOINT}px) {
    flex-direction: column;
    height: auto;
    min-height: 100vh;
    overflow: visible;

    /* Stack both regions at their natural height and let the whole page
       scroll, rather than pinning them to the viewport and competing for its
       height (which collapses the wall region to nothing). */
    > .grid-container {
      flex: 0 0 auto;
    }

    > .stream-list {
      flex: 0 0 auto;
      min-width: 0;
      overflow-y: visible;
    }
  }
`

function StreamDurationClock({ startTime }: { startTime: number }) {
  const [now, setNow] = useState(() => DateTime.now())
  useEffect(() => {
    const interval = setInterval(() => {
      setNow(DateTime.now())
    }, 500)
    return () => {
      clearInterval(interval)
    }
  }, [startTime])
  return (
    <span>{now.diff(DateTime.fromMillis(startTime)).toFormat('hh:mm:ss')}</span>
  )
}

function StreamDelayBox({
  role,
  delayState,
  setStreamCensored,
  setStreamRunning,
}: {
  role: StreamwallRole | null
  delayState: StreamDelayStatus
  setStreamCensored: (isCensored: boolean) => void
  setStreamRunning: (isStreamRunning: boolean) => void
}) {
  const handleToggleStreamCensored = useCallback(() => {
    setStreamCensored(!delayState.isCensored)
  }, [delayState.isCensored, setStreamCensored])
  const handleToggleStreamRunning = useCallback(() => {
    if (!delayState.isStreamRunning || confirm('End stream?')) {
      setStreamRunning(!delayState.isStreamRunning)
    }
  }, [delayState.isStreamRunning, setStreamRunning])
  let buttonText
  if (delayState.isConnected) {
    if (matchesState('censorship.censored.deactivating', delayState.state)) {
      buttonText = 'Deactivating...'
    } else if (delayState.isCensored) {
      buttonText = 'Uncensor stream'
    } else {
      buttonText = 'Censor stream'
    }
  }
  return (
    <div>
      <StyledStreamDelayBox>
        <strong>Streamdelay</strong>
        {!delayState.isConnected && <span>connecting...</span>}
        {!delayState.isStreamRunning && <span>stream stopped</span>}
        {delayState.isConnected && (
          <>
            {delayState.startTime !== null && (
              <StreamDurationClock startTime={delayState.startTime} />
            )}
            <span>delay: {delayState.delaySeconds}s</span>
            {delayState.isStreamRunning && (
              <StyledButton
                $isActive={delayState.isCensored}
                onClick={handleToggleStreamCensored}
              >
                {buttonText}
              </StyledButton>
            )}
            {roleCan(role, 'set-stream-running') && (
              <StyledButton onClick={handleToggleStreamRunning}>
                {delayState.isStreamRunning ? 'End stream' : 'Start stream'}
              </StyledButton>
            )}
          </>
        )}
      </StyledStreamDelayBox>
    </div>
  )
}

const StyledHeader = styled.header`
  display: flex;
  align-items: center;
  gap: 18px;
  flex: 0 0 auto;
  position: relative;
  padding: 4px 2px 14px;
  margin-bottom: 14px;

  /* Stencil-editorial anchor: a red rule that runs out into the border line. */
  &::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 2px;
    background: linear-gradient(
      90deg,
      var(--accent) 0 132px,
      var(--border) 132px
    );
  }

  .wm {
    font-family: var(--font-display);
    font-size: 27px;
    line-height: 1;
    letter-spacing: 0.03em;
    color: var(--text);
    white-space: nowrap;
  }
  .wm span {
    color: var(--accent);
  }

  .crumbs {
    font-family: var(--font-mono);
    font-size: 12px;
    letter-spacing: 0.04em;
    color: var(--text-faint);
  }
  .crumbs b {
    color: var(--text-dim);
    font-weight: 500;
  }

  .spacer {
    flex: 1;
  }

  .livecount {
    font-family: 'Oswald', var(--font-ui);
    text-transform: uppercase;
    font-weight: 600;
    font-size: 13px;
    letter-spacing: 0.12em;
    color: var(--accent);
    border: 1px solid var(--accent);
    background: var(--accent-soft);
    padding: 5px 11px;
  }

  .status {
    display: flex;
    align-items: center;
    gap: 7px;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.02em;
    color: var(--text-dim);
    text-transform: uppercase;
  }
  .status .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
  .status .dot.on {
    background: var(--ok);
  }
  .status .dot.off {
    background: var(--text-faint);
  }

  /* On narrow screens the header controls no longer fit on one line - let them
     wrap instead of overflowing the viewport (see #81). */
  @media (max-width: ${NARROW_BREAKPOINT}px) {
    flex-wrap: wrap;
    gap: 10px 14px;
  }
`

const StyledStreamDelayBox = styled.div`
  display: inline-flex;
  align-items: center;
  margin: 5px 0;
  padding: 10px 12px;
  gap: 1em;
  border-radius: var(--r-md);
  background: var(--accent-soft);
  border: 1px solid var(--accent);
  color: var(--text);
`

const StyledGridPreview = styled.div`
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
`

const StyledGridInputs = styled.div`
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  transition: opacity 100ms ease-out;
  overflow: hidden;
  z-index: 100;
`

const StyledGridContainer = styled.div<{
  $windowWidth: number
  $windowHeight: number
}>`
  position: relative;
  /* Responsive: keep the wall's aspect ratio but fit the available space
     instead of a hard-coded pixel size, so the layout never overflows. */
  aspect-ratio: ${({ $windowWidth, $windowHeight }) =>
    `${$windowWidth} / ${$windowHeight}`};
  width: 100%;
  max-height: 100%;
  margin: 0 auto;
  border: 1px solid var(--border-2);
  border-radius: var(--r-md);
  background: var(--cell-bg);
  overflow: hidden;

  &:hover ${StyledGridInputs} {
    opacity: 0.35;
  }
`

const StyledNewInviteBox = styled.div`
  display: block;
  padding: 10px 12px;
  margin: 8px 0;
  border-radius: var(--r-md);
  background: color-mix(in srgb, var(--ok) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--ok) 45%, transparent);
  color: var(--text);
  font-size: 13px;
`

const StyledStatusBar = styled.div`
  display: flex;
  align-items: center;
  gap: 14px;
  flex: 0 0 auto;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-dim);

  .spacer {
    flex: 1;
  }

  .meta {
    color: var(--text-faint);
  }

  label.dbg {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  label.dbg input {
    accent-color: var(--accent);
  }
`
