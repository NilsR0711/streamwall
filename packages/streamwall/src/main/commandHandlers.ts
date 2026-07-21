import { type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { type ControlCommand, type StreamwallState } from 'streamwall-shared'
import * as Y from 'yjs'
import {
  type CommandSource,
  type ControlCommandResult,
} from './commandDispatch'
import { type LocalStreamData } from './data'
import { addFavorite, removeFavorite } from './favorites'
import { applyGridResize } from './gridResize'
import {
  addLayoutPreset,
  applyLayoutPreset,
  buildLayoutPreset,
} from './layoutPresets'
import log from './logger'
import { type default as StreamdelayClient } from './StreamdelayClient'
import { type default as StreamWindow } from './StreamWindow'
import { checkUplinkCommandGate } from './uplinkCommandGate'

/** The `browseWindow` surface the browse / dev-tools commands drive. */
export interface BrowseWindow {
  isDestroyed(): boolean
  destroy(): void
  loadURL(url: string): unknown
  webContents: WebContents
}

/** The StreamWindow methods reachable from control commands. */
export type CommandStreamWindow = Pick<
  StreamWindow,
  | 'setListeningView'
  | 'setViewBackgroundListening'
  | 'setViewBlurred'
  | 'setViewVolume'
  | 'reloadView'
  | 'setGridSize'
  | 'openDevTools'
  | 'getViewAnchorIdx'
>

export interface CommandHandlerDeps {
  streamWindow: CommandStreamWindow
  /** Overlay data source (rotation overrides). */
  overlayStreamData: Pick<LocalStreamData, 'update'>
  /** Operator-defined custom streams. */
  localStreamData: Pick<LocalStreamData, 'update' | 'delete'>
  /** Yjs map of grid cell index (as string) -> a `{ streamId }` map. */
  viewsState: Y.Map<Y.Map<string | undefined>>
  /** Runs `fn` inside the shared `stateDoc.transact`, batching the mutations. */
  transact: (fn: () => void) => void
  /** The shared, mutated-in-place stream window config (grid dimensions). */
  streamWindowConfig: { cols: number; rows: number }
  /** Reads the current broadcast client state (layout presets, favorites). */
  getClientState: () => StreamwallState
  /** The stream-delay client, or null when none is configured. */
  getStreamdelayClient: () => Pick<
    StreamdelayClient,
    'setCensored' | 'setStreamRunning'
  > | null
  /** Merges a partial into the client state and rebroadcasts it. */
  updateState: (partial: Partial<StreamwallState>) => void
  /** Re-derives the wall layout from the current stateDoc + streams. */
  updateViewsFromStateDoc: () => void
  /** Persists the layout presets to storage. */
  persistLayoutPresets: (presets: StreamwallState['layoutPresets']) => void
  /** Persists the favorites to storage. */
  persistFavorites: (favorites: StreamwallState['favorites']) => void
  /**
   * Creates a hardened, isolated browse window. Injected so the security
   * wiring (partition, session hardening, popup denial) stays at the call site
   * and the command routing can be tested without the Electron runtime.
   */
  createBrowseWindow: () => BrowseWindow
  /**
   * Validates a URL against the browse window's session before it is loaded,
   * throwing when the URL is disallowed.
   */
  validateBrowseURL: (url: string, browseWindow: BrowseWindow) => Promise<void>
  /** Generates a unique id for a saved layout preset (defaults to randomUUID). */
  generateId?: () => string
}

/**
 * Builds the control-command handler that routes every `ControlCommand` — from
 * the local control window or the remote uplink — to the matching collaborator.
 *
 * The returned handler owns the lifecycle of the ephemeral browse window
 * (created on demand, destroyed and recreated for dev-tools), the only piece of
 * mutable state local to command handling.
 */
export function createOnCommand(deps: CommandHandlerDeps) {
  const generateId = deps.generateId ?? randomUUID
  let browseWindow: BrowseWindow | null = null

  return async (
    msg: ControlCommand,
    source: CommandSource = 'local',
  ): Promise<ControlCommandResult | void> => {
    log.debug('Received message:', msg)

    // The remote control-server uplink is untrusted: re-validate every command
    // against the uplink allowlist so a compromised or man-in-the-middled
    // server cannot drive code execution (browse/dev-tools) on the desktop.
    const uplinkGate = checkUplinkCommandGate(msg, source)
    if (!uplinkGate.allowed) {
      log.warn(
        'Rejecting disallowed command from control uplink:',
        uplinkGate.type,
      )
      return
    }

    const streamdelayClient = deps.getStreamdelayClient()

    if (msg.type === 'set-listening-view') {
      log.debug('Setting listening view:', msg.viewId)
      deps.streamWindow.setListeningView(msg.viewId)
    } else if (msg.type === 'set-view-background-listening') {
      log.debug('Setting view background listening:', msg.viewId, msg.listening)
      deps.streamWindow.setViewBackgroundListening(msg.viewId, msg.listening)
    } else if (msg.type === 'set-view-blurred') {
      log.debug('Setting view blurred:', msg.viewId, msg.blurred)
      deps.streamWindow.setViewBlurred(msg.viewId, msg.blurred)
    } else if (msg.type === 'set-view-volume') {
      log.debug('Setting view volume:', msg.viewId, msg.volume)
      deps.streamWindow.setViewVolume(msg.viewId, msg.volume)
    } else if (msg.type === 'rotate-stream') {
      log.debug('Rotating stream:', msg.url, msg.rotation)
      deps.overlayStreamData.update(msg.url, {
        rotation: msg.rotation,
      })
    } else if (msg.type === 'update-custom-stream') {
      log.debug('Updating custom stream:', msg.url)
      deps.localStreamData.update(msg.url, msg.data)
    } else if (msg.type === 'delete-custom-stream') {
      log.debug('Deleting custom stream:', msg.url)
      deps.localStreamData.delete(msg.url)
    } else if (msg.type === 'reload-view') {
      log.debug('Reloading view:', msg.viewId)
      deps.streamWindow.reloadView(msg.viewId)
    } else if (msg.type === 'set-view-fullscreen') {
      // Runtime-only wall zoom (issue #362): remember which view fills the
      // wall (or null) and re-derive the layout. Broadcast the new value first
      // so clients render the expansion consistently, then re-lay-out the wall.
      //
      // The command carries a stable view id (issue #397); resolve it to the
      // cell that view currently occupies so the cell-based `fullscreenViewIdx`
      // (which the layout state and clients still key on) reflects the view the
      // operator actually double-clicked, even if a resize just moved it. If
      // the view has no placement, `getViewAnchorIdx` returns null and no
      // expansion happens.
      log.debug('Setting view fullscreen:', msg.viewId, msg.fullscreen)
      deps.updateState({
        fullscreenViewIdx: msg.fullscreen
          ? deps.streamWindow.getViewAnchorIdx(msg.viewId)
          : null,
      })
      deps.updateViewsFromStateDoc()
    } else if (msg.type === 'browse' || msg.type === 'dev-tools') {
      if (browseWindow && !browseWindow.isDestroyed()) {
        // DevTools needs a fresh webContents to work. Close any existing window.
        browseWindow.destroy()
        browseWindow = null
      }
      if (!browseWindow || browseWindow.isDestroyed()) {
        browseWindow = deps.createBrowseWindow()
      }
      if (msg.type === 'browse') {
        log.debug('Attempting to browse URL:', msg.url)
        try {
          await deps.validateBrowseURL(msg.url, browseWindow)
          browseWindow.loadURL(msg.url)
        } catch (error) {
          log.error('Invalid URL:', msg.url)
          log.error('Error:', error)
          return { error: 'invalid url' }
        }
      } else if (msg.type === 'dev-tools') {
        log.debug('Opening DevTools for view:', msg.viewId)
        deps.streamWindow.openDevTools(msg.viewId, browseWindow.webContents)
      }
    } else if (msg.type === 'set-stream-censored' && streamdelayClient) {
      log.debug('Setting stream censored:', msg.isCensored)
      streamdelayClient.setCensored(msg.isCensored)
    } else if (msg.type === 'set-stream-running' && streamdelayClient) {
      log.debug('Setting stream running:', msg.isStreamRunning)
      streamdelayClient.setStreamRunning(msg.isStreamRunning)
    } else if (msg.type === 'set-grid-size') {
      applyGridResize(
        {
          viewsState: deps.viewsState,
          transact: deps.transact,
          getCols: () => deps.streamWindowConfig.cols,
          getRows: () => deps.streamWindowConfig.rows,
          setGridSize: (cols, rows) =>
            deps.streamWindow.setGridSize(cols, rows),
        },
        msg.cols,
        msg.rows,
      )

      // streamWindow.config, streamWindowConfig and clientState.config are the
      // same shared object, and setGridSize mutates it in place. Broadcast that
      // shared object via updateState({}) rather than detaching a copy, so a
      // later window resize keeps the overlay/control grid in sync with the wall
      // (issue #14). The wall itself was already re-laid-out by the stateDoc
      // observer during applyGridResize's transact — now that the config holds
      // the new dimensions (issue #15) — so no explicit updateViewsFromStateDoc()
      // call is needed here.
      deps.updateState({})
    } else if (msg.type === 'save-layout-preset') {
      log.debug('Saving layout preset:', msg.name)
      const preset = buildLayoutPreset(
        {
          viewsState: deps.viewsState,
          cols: deps.streamWindowConfig.cols,
          rows: deps.streamWindowConfig.rows,
        },
        generateId(),
        msg.name,
      )
      const layoutPresets = addLayoutPreset(
        deps.getClientState().layoutPresets,
        preset,
      )
      deps.persistLayoutPresets(layoutPresets)
      deps.updateState({ layoutPresets })
    } else if (msg.type === 'load-layout-preset') {
      const preset = deps
        .getClientState()
        .layoutPresets.find((p) => p.id === msg.presetId)
      if (preset) {
        log.debug('Loading layout preset:', preset.name)
        applyLayoutPreset(
          {
            viewsState: deps.viewsState,
            transact: deps.transact,
            setGridSize: (cols, rows) =>
              deps.streamWindow.setGridSize(cols, rows),
          },
          preset,
        )
        // See the set-grid-size branch above: broadcast the shared config
        // object via updateState({}) rather than detaching a copy.
        deps.updateState({})
      }
    } else if (msg.type === 'delete-layout-preset') {
      log.debug('Deleting layout preset:', msg.presetId)
      const layoutPresets = deps
        .getClientState()
        .layoutPresets.filter((p) => p.id !== msg.presetId)
      deps.persistLayoutPresets(layoutPresets)
      deps.updateState({ layoutPresets })
    } else if (msg.type === 'add-favorite') {
      const clientState = deps.getClientState()
      const favorites = addFavorite(clientState.favorites, msg.url)
      if (favorites !== clientState.favorites) {
        log.debug('Adding favorite:', msg.url)
        deps.persistFavorites(favorites)
        deps.updateState({ favorites })
      }
    } else if (msg.type === 'remove-favorite') {
      const clientState = deps.getClientState()
      const favorites = removeFavorite(clientState.favorites, msg.url)
      if (favorites !== clientState.favorites) {
        log.debug('Removing favorite:', msg.url)
        deps.persistFavorites(favorites)
        deps.updateState({ favorites })
      }
    }
  }
}
