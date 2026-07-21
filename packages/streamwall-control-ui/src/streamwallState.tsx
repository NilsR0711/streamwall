import { orderBy } from 'lodash-es'
import { useMemo } from 'preact/hooks'
import {
  type ControlCommand,
  type DataSourceHealth,
  type DisconnectReason,
  type LayoutPreset,
  type StreamData,
  type StreamDelayStatus,
  type StreamwallRole,
  type StreamwallState,
  type StreamWindowConfig,
  type ViewState,
} from 'streamwall-shared'
import { matchesState } from 'xstate'
import * as Y from 'yjs'
import { type CollabData } from './collabData.ts'
import { asCellIdx, asCellIdxs, type CellIdx } from './viewAddressing.ts'

export interface ViewInfo {
  state: ViewState
  isListening: boolean
  isBackgroundListening: boolean
  isBlurred: boolean
  /**
   * Media playback is paused because the view is parked behind a fullscreen
   * expansion and the wall runs with `--park.pause` (issue #374). Purely
   * informational here: there is no control command to toggle it.
   */
  isPaused: boolean
  volume: number
  /** The grid cells this view occupies — never view ids (issue #507). */
  spaces: CellIdx[]
}

/**
 * The transport-agnostic view of a live control connection consumed by
 * `<ControlUI>`. Both the Electron IPC renderer and the standalone WebSocket
 * client produce one of these via `useCollabConnection` (see
 * `./useCollabConnection.ts`); the shared hook owns the Yjs origin rules and
 * doc-reset policy so the two paths cannot drift (issue #396).
 */
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
  /**
   * Anchor cell index of the view currently expanded to fill the whole wall,
   * or `null` for the normal grid layout (issue #362).
   */
  fullscreenViewIdx: CellIdx | null
  stateIdxMap: Map<CellIdx, ViewInfo>
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
        fullscreenViewIdx: null,
        stateIdxMap: new Map<CellIdx, ViewInfo>(),
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
      fullscreenViewIdx,
      streamdelay,
      layoutPresets,
      favorites,
      dataSourceHealth,
    } = state
    const stateIdxMap = new Map<CellIdx, ViewInfo>()
    const views: ViewInfo[] = []
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
      const isPaused = matchesState(
        'displaying.running.pause.paused',
        viewState.state,
      )
      const spaces = asCellIdxs(pos?.spaces ?? [])
      const viewInfo: ViewInfo = {
        state: viewState,
        isListening,
        isBackgroundListening,
        isBlurred,
        isPaused,
        volume: viewState.context.volume,
        spaces,
      }
      views.push(viewInfo)
      // Every occupied cell points at the view itself. Two views can only
      // claim the same cell while the wall is mid-relayout; the later one wins,
      // as it did when this merged onto a placeholder object (issue #507).
      for (const space of spaces) {
        stateIdxMap.set(space, viewInfo)
      }
    }

    const streams = orderBy(stateStreams, ['addedDate', '_id'], ['desc', 'asc'])
    const customStreams = stateStreams.filter((s) => s._dataSource === 'custom')

    return {
      role,
      authState: auth,
      delayState: streamdelay,
      views,
      // Despite its name this is the anchor *cell* of the expanded view, not a
      // view id (issue #362).
      fullscreenViewIdx:
        fullscreenViewIdx == null ? null : asCellIdx(fullscreenViewIdx),
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
