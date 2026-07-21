import '@fontsource/noto-sans'
// Design system fonts (bundled so they work under the strict app CSP).
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/700.css'
import '@fontsource/oswald/600.css'
import '@fontsource/saira-stencil-one'
import { useCallback, useMemo, useState } from 'preact/hooks'
import { roleCan } from 'streamwall-shared'
import { createErrorSurfacingSend } from './commandError.ts'
import { ControlBanners } from './components/ControlBanners.tsx'
import { ControlGrid } from './components/ControlGrid.tsx'
import { ControlHeader } from './components/ControlHeader.tsx'
import { ControlSidebar } from './components/ControlSidebar.tsx'
import { ControlStatusBar } from './components/ControlStatusBar.tsx'
import { StreamDelayBox } from './components/StreamDelayBox.tsx'
import { useControlHotkeys } from './hooks/useControlHotkeys.ts'
import { useGridCommands } from './hooks/useGridCommands.ts'
import { useStreamFilters } from './hooks/useStreamFilters.ts'
import './index.css'
import { type Invite } from './invite.ts'
import { AppShell, Stack } from './layout.tsx'
import { type StreamwallConnection } from './streamwallState.tsx'
import { StyledDataContainer } from './StyledButton.tsx'
import { useServerStatus } from './useServerStatus.ts'
import { useTileDrag } from './useTileDrag.ts'
import { useTileResize } from './useTileResize.ts'

// Re-exported for `streamwall-control-client` and `streamwall`'s renderer,
// which mount it alongside `<ControlUI>` — its implementation now lives in
// `./globalStyle.tsx` alongside the theme tokens it applies.
export { GlobalStyle } from './globalStyle.tsx'

export { collabDataSchema, type CollabData } from './collabData.ts'
export {
  useStreamwallState,
  type StreamwallConnection,
  type ViewInfo,
} from './streamwallState.tsx'
export {
  useCollabConnection,
  type CollabTransport,
  type CollabTransportEvents,
} from './useCollabConnection.ts'
export { useYDoc } from './useYDoc.ts'

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
    fullscreenViewIdx,
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

  // `local` is the desktop app's own IPC role, which has no `/admin/status`
  // HTTP endpoint to fetch (issue #436) - the Electron app surfaces its own
  // update state separately (issue #382).
  const serverStatus = useServerStatus(
    role !== 'local' && roleCan(role, 'view-server-status'),
  )

  // Surfaces `{ error }` command responses that would otherwise be dropped
  // silently by the many call sites below that don't pass their own
  // response callback (issue #35).
  const [commandError, setCommandError] = useState<string | null>(null)
  const send = useMemo(
    () => createErrorSurfacingSend(connectionSend, setCommandError),
    [connectionSend],
  )

  const [showDebug, setShowDebug] = useState(false)

  const tileDrag = useTileDrag({ cols, rows, stateDoc, stateIdxMap, role })
  const tileResize = useTileResize({
    cols,
    rows,
    hoveringIdx: tileDrag.hoveringIdx,
    stateDoc,
    sharedState,
    role,
  })

  const [focusedInputIdx, setFocusedInputIdx] = useState<number | undefined>()
  const handleBlurInput = useCallback(() => setFocusedInputIdx(undefined), [])

  const {
    streamFilter,
    handleStreamFilterChange,
    favoritesSet,
    wallStreams,
    liveStreams,
    otherStreams,
    favoriteStreams,
  } = useStreamFilters({ streams, sharedState, favorites })

  const [newInvite, setNewInvite] = useState<Invite>()

  const {
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
  } = useGridCommands({
    send,
    streams,
    sharedState,
    stateDoc,
    cols,
    rows,
    fullscreenViewIdx,
    focusedInputIdx,
    favoritesSet,
    onInvite: setNewInvite,
    onError: setCommandError,
  })

  useControlHotkeys({
    stateIdxMap,
    focusedInputIdx,
    role,
    handleSetListening,
    handleSetBlurred,
    setStreamCensored,
    handleSwapView: tileDrag.handleSwapView,
    undoManager,
  })

  return (
    <AppShell className="app-shell">
      <Stack className="grid-container">
        <ControlHeader
          cols={cols}
          rows={rows}
          role={role}
          onSetGridSize={handleSetGridSize}
          presets={layoutPresets}
          onSavePreset={handleSaveLayoutPreset}
          onLoadPreset={handleLoadLayoutPreset}
          onDeletePreset={handleDeleteLayoutPreset}
          liveCount={liveStreams.length}
          isConnected={isConnected}
          serverVersion={serverStatus?.version ?? null}
        />
        <ControlBanners
          isConnected={isConnected}
          disconnectReason={disconnectReason}
          dataSourceHealth={dataSourceHealth}
          serverStatus={serverStatus}
          commandError={commandError}
          onDismissError={() => setCommandError(null)}
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
            <ControlGrid
              cols={cols}
              rows={rows}
              windowWidth={windowWidth}
              windowHeight={windowHeight}
              role={role}
              showDebug={showDebug}
              sharedState={sharedState}
              views={views}
              stateIdxMap={stateIdxMap}
              streams={streams}
              fullscreenViewIdx={fullscreenViewIdx}
              tileDrag={tileDrag}
              tileResize={tileResize}
              onSetView={handleSetView}
              onFocusInput={setFocusedInputIdx}
              onBlurInput={handleBlurInput}
              onToggleFullscreen={handleToggleFullscreen}
              onSetListening={handleSetListening}
              onSetBackgroundListening={handleSetBackgroundListening}
              onSetBlurred={handleSetBlurred}
              onSetVolume={handleSetVolume}
              onReloadView={handleReloadView}
              onRotateView={handleRotateStream}
              onBrowse={handleBrowse}
              onDevTools={handleDevTools}
            />
          )}
        </StyledDataContainer>
        <ControlStatusBar
          role={role}
          showDebug={showDebug}
          onSetShowDebug={setShowDebug}
          sourceCount={streams.length}
          liveCount={liveStreams.length}
        />
      </Stack>
      <ControlSidebar
        role={role}
        isConnected={isConnected}
        streamFilter={streamFilter}
        onStreamFilterChange={handleStreamFilterChange}
        favoriteStreams={favoriteStreams}
        wallStreams={wallStreams}
        liveStreams={liveStreams}
        otherStreams={otherStreams}
        favoritesSet={favoritesSet}
        onClickId={handleClickId}
        onToggleFavorite={handleToggleFavorite}
        customStreams={customStreams}
        onChangeCustomStream={handleChangeCustomStream}
        onDeleteCustomStream={handleDeleteCustomStream}
        authState={authState}
        newInvite={newInvite}
        onCreateInvite={handleCreateInvite}
        onDeleteToken={handleDeleteToken}
      />
    </AppShell>
  )
}
