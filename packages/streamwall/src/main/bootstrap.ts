import { throttle } from 'lodash-es'
import { join } from 'node:path'
import type {
  DataSourceType,
  StreamWindowConfig,
  StreamwallState,
  ViewId,
  ViewState,
} from 'streamwall-shared'
import * as Y from 'yjs'
import type { StreamwallConfig } from './cliArgs'
import type { ControlCommandHandler } from './ControlWindow'
import { LocalStreamData } from './data'
import { DataSourceHealthTracker } from './dataSourceHealth'
import log from './logger'
import { type PlaylistConfig, PlaylistScheduler } from './playlist'
import StreamdelayClient from './StreamdelayClient'
import TwitchBot from './TwitchBot'
import { initializeViewsState } from './viewsStateInit'
import {
  shouldHideInsteadOfQuit,
  shouldQuitOnAllWindowsClosed,
} from './windowCloseBehavior'

/**
 * The individually testable startup phases of the main process.
 *
 * `main()` (index.ts) is a thin sequencer over these functions. Electron
 * startup is order-sensitive, so every phase takes its collaborators
 * explicitly instead of reaching for module-level state, and the phases must
 * be called in the same order they are declared to run in `main()`.
 */

/** The minimal shape of an event whose default action can be prevented. */
export interface PreventableEvent {
  preventDefault: () => void
}

/** Where the user's `config.toml` lives, and whether it exists yet. */
export interface UserConfigLocation {
  userConfigPath: string
  hasUserConfig: boolean
}

export interface ApplicationMenuPhaseDeps {
  /** Electron's `userData` directory. */
  userDataPath: string
  /** Path of the current log file, for the "Open Log File" menu item. */
  logFilePath: string
  fileExists: (path: string) => boolean
  installMenu: (
    configPath: string,
    logPath: string,
    hasUserConfig: boolean,
  ) => void
}

/**
 * Resolves the user config location and installs the application menu.
 *
 * The config path is recomputed here rather than threaded out of `parseArgs`,
 * keeping the existence check local to the two consumers that need it: the
 * "Open Config Folder" menu item and the control UI's first-run hint (#86).
 */
export function setupApplicationMenu(
  deps: ApplicationMenuPhaseDeps,
): UserConfigLocation {
  const userConfigPath = join(deps.userDataPath, 'config.toml')
  const hasUserConfig = deps.fileExists(userConfigPath)
  deps.installMenu(userConfigPath, deps.logFilePath, hasUserConfig)
  return { userConfigPath, hasUserConfig }
}

export interface LocalStreamDataPhaseDeps {
  initialEntries: ConstructorParameters<typeof LocalStreamData>[0]
  persistEntries: (
    entries: NonNullable<ConstructorParameters<typeof LocalStreamData>[0]>,
  ) => void
}

/**
 * Creates the operator-editable stream data store and mirrors every change
 * back into persistent storage.
 */
export function createPersistedLocalStreamData(
  deps: LocalStreamDataPhaseDeps,
): LocalStreamData {
  const localStreamData = new LocalStreamData(deps.initialEntries)
  localStreamData.on('update', (entries) => {
    deps.persistEntries(entries)
  })
  return localStreamData
}

export interface InitialClientStateDeps {
  config: StreamWindowConfig
  layoutPresets: StreamwallState['layoutPresets']
  favorites: StreamwallState['favorites']
}

/** Builds the initial broadcast state, seeded from persisted storage. */
export function createInitialClientState(
  deps: InitialClientStateDeps,
): StreamwallState {
  return {
    identity: {
      role: 'local',
    },
    config: deps.config,
    streams: [],
    customStreams: [],
    views: [],
    fullscreenViewIdx: null,
    streamdelay: null,
    layoutPresets: deps.layoutPresets,
    favorites: deps.favorites,
    dataSourceHealth: [],
  }
}

/**
 * Restores a base64-encoded Yjs snapshot into `stateDoc`.
 *
 * A corrupt snapshot must not take down startup: the app falls back to an
 * empty doc, which the view-state seeding below refills.
 */
export function restoreStateDoc(stateDoc: Y.Doc, encoded: string): void {
  log.info('Loading stateDoc from storage...')
  try {
    Y.applyUpdate(stateDoc, Buffer.from(encoded, 'base64'))
  } catch (err) {
    log.warn('Failed to restore stateDoc', err)
  }
}

export interface StateDocPersisterDeps {
  stateDoc: Y.Doc
  /** Writes the encoded full-doc snapshot to storage. */
  saveSnapshot: (encoded: string) => void
  /** Throttle window in milliseconds. */
  wait?: number
}

/**
 * Persists the Yjs doc on every update, throttled.
 *
 * Returns the throttled function so a shutdown hook can `flush()` any pending
 * write before the process exits.
 */
export function createStateDocPersister(deps: StateDocPersisterDeps) {
  const persistStateDoc = throttle(() => {
    const fullDoc = Y.encodeStateAsUpdate(deps.stateDoc)
    deps.saveSnapshot(Buffer.from(fullDoc).toString('base64'))
  }, deps.wait ?? 1000)
  deps.stateDoc.on('update', persistStateDoc)
  return persistStateDoc
}

export interface ViewsStateSeedDeps {
  viewsState: Y.Map<Y.Map<string | undefined>>
  transact: (fn: () => void) => void
  cols: number
  rows: number
  /** Re-derives the wall layout from the current doc state. */
  updateViews: () => void
}

/**
 * Seeds the view-state doc for the configured grid, renders it once, and then
 * keeps the wall in sync with later edits.
 *
 * Ordering matters: `observeDeep` fires synchronously at the end of a
 * `transact`, so anything the observer reads (the grid `cols`/`rows` of the
 * stream window config) must already be set before the seeding transaction
 * runs. Registering the observer *after* the seeding also keeps the initial
 * render a single explicit call rather than an observer side effect.
 */
export function seedAndObserveViewsState(deps: ViewsStateSeedDeps): void {
  initializeViewsState(
    { viewsState: deps.viewsState, transact: deps.transact },
    deps.cols,
    deps.rows,
  )
  deps.updateViews()
  deps.viewsState.observeDeep(deps.updateViews)
}

export interface PlaylistPhaseDeps {
  playlists: PlaylistConfig[]
  /** The stream list the configured playlist URLs are resolved against. */
  getStreams: () => StreamwallState['streams']
  viewsState: Y.Map<Y.Map<string | undefined>>
  transact: (fn: () => void) => void
}

/**
 * Starts the playlist scheduler, which cycles any configured views through
 * their list of stream URLs -- independent of whatever data source populated
 * the stream list.
 */
export function startPlaylistScheduler(
  deps: PlaylistPhaseDeps,
): PlaylistScheduler {
  const playlistScheduler = new PlaylistScheduler(deps.playlists, {
    resolveStreamId: (url) => {
      const streams = deps.getStreams()
      return (streams.byURL?.get(url) ?? streams.find((s) => s.link === url))
        ?._id
    },
    setViewStream: (view, streamId) => {
      deps.transact(() => {
        deps.viewsState.get(String(view))?.set('streamId', streamId)
      })
    },
  })
  playlistScheduler.start()
  return playlistScheduler
}

/** The bits of a browse window the hardening steps need. */
export interface BrowseWindowLike<TSession, TWebContents> {
  webContents: TWebContents & { session: TSession }
}

export interface BrowseWindowFactoryDeps<
  TSession,
  TWebContents,
  TWindow extends BrowseWindowLike<TSession, TWebContents>,
> {
  createWindow: () => TWindow
  hardenSession: (session: TSession) => void
  denyWindowOpen: (webContents: TWebContents) => void
}

/**
 * Opens a window for the operator's ad-hoc browsing, isolated from the stream
 * views: an ephemeral partition keeps it off disk, and popups are denied
 * because the browse window is meant to show a single URL.
 */
export function createBrowseWindow<
  TSession,
  TWebContents,
  TWindow extends BrowseWindowLike<TSession, TWebContents>,
>(deps: BrowseWindowFactoryDeps<TSession, TWebContents, TWindow>): TWindow {
  const win = deps.createWindow()
  deps.hardenSession(win.webContents.session)
  deps.denyWindowOpen(win.webContents)
  return win
}

export interface StreamWindowIpcTarget {
  on(event: 'state', listener: (viewStates: ViewState[]) => void): unknown
  on(event: 'resize', listener: () => void): unknown
  on(event: 'load', listener: () => void): unknown
  onState(state: StreamwallState): void
}

export interface ControlWindowIpcTarget {
  on(event: 'load', listener: () => void): unknown
  on(event: 'ydoc', listener: (update: Uint8Array) => void): unknown
  onState(state: StreamwallState): void
  onYDocUpdate(update: Uint8Array): void
  setCommandHandler(handler: ControlCommandHandler): void
}

export interface WindowIpcDeps {
  streamWindow: StreamWindowIpcTarget
  controlWindow: ControlWindowIpcTarget
  stateDoc: Y.Doc
  /** Merges a partial state and rebroadcasts it. */
  updateState: (newState: Partial<StreamwallState>) => void
  updateViewsFromStateDoc: () => void
  getClientState: () => StreamwallState
  /** Decides whether a doc update should be echoed to the control window. */
  shouldForwardUpdate: (origin: unknown) => boolean
  /** Transaction origin tagged onto updates coming from the control window. */
  controlWindowOrigin: unknown
  handleCommand: ControlCommandHandler
}

/** Wires the message flow between the two windows and the shared state doc. */
export function wireWindowIpc(deps: WindowIpcDeps): void {
  // StreamWindow view updates -> main
  deps.streamWindow.on('state', (viewStates) => {
    deps.updateState({ views: viewStates })
  })

  // StreamWindow resized -> re-layout stream views and rebroadcast state so the
  // overlay grid matches the new window dimensions.
  deps.streamWindow.on('resize', () => {
    deps.updateViewsFromStateDoc()
    deps.updateState({})
  })

  // StreamWindow <- main init state
  deps.streamWindow.on('load', () => {
    deps.streamWindow.onState(deps.getClientState())
  })

  // Control <- main collab updates
  deps.stateDoc.on('update', (update: Uint8Array, origin: unknown) => {
    if (!deps.shouldForwardUpdate(origin)) {
      return
    }
    deps.controlWindow.onYDocUpdate(update)
  })

  // Control <- main init state
  deps.controlWindow.on('load', () => {
    deps.controlWindow.onState(deps.getClientState())
    deps.controlWindow.onYDocUpdate(Y.encodeStateAsUpdate(deps.stateDoc))
  })

  // Control -> main
  deps.controlWindow.on('ydoc', (update) => {
    Y.applyUpdate(deps.stateDoc, update, deps.controlWindowOrigin)
  })
  deps.controlWindow.setCommandHandler(deps.handleCommand)
}

export interface LifecycleWindow {
  win: { show: () => void; hide: () => void }
  on(event: 'close', listener: (event: PreventableEvent) => void): unknown
}

export interface LifecycleApp {
  on(event: 'before-quit', listener: (event: PreventableEvent) => void): unknown
  on(event: 'activate', listener: () => void): unknown
  on(event: 'window-all-closed', listener: () => void): unknown
  quit(): void
}

export interface WindowLifecycleDeps {
  app: LifecycleApp
  platform: NodeJS.Platform
  streamWindow: LifecycleWindow
  controlWindow: LifecycleWindow
  /** Forces any pending storage write to disk before the process exits. */
  flushStorage: () => Promise<void>
}

/**
 * Wires window close, dock re-activation and shutdown behaviour.
 *
 * Handler registration order is significant and matches the original inline
 * code: the quit-intent flag is set before the storage flush hook runs, so the
 * flush's `app.quit()` is not mistaken for a fresh close.
 */
export function wireWindowLifecycle(deps: WindowLifecycleDeps): void {
  // Closing either top-level window quits the app, except on macOS where the
  // convention is to hide the window and keep the app (and its dock icon)
  // running until the user explicitly quits.
  let isQuitting = false
  let storageFlushed = false
  deps.app.on('before-quit', () => {
    isQuitting = true
  })
  deps.app.on('activate', () => {
    deps.streamWindow.win.show()
    deps.controlWindow.win.show()
  })

  function handleWindowClose(
    window: LifecycleWindow,
    event: PreventableEvent,
  ): void {
    if (shouldHideInsteadOfQuit(deps.platform, isQuitting)) {
      event.preventDefault()
      window.win.hide()
      return
    }
    deps.app.quit()
  }
  deps.streamWindow.on('close', (event) => {
    handleWindowClose(deps.streamWindow, event)
  })
  deps.controlWindow.on('close', (event) => {
    handleWindowClose(deps.controlWindow, event)
  })

  // Standard Electron convention as a safety net: if every window somehow
  // ends up closed without the app already quitting (e.g. a future window
  // added without wiring into the close handling above), quit rather than
  // linger as a windowless background process. macOS is excluded, matching
  // the hide-instead-of-quit convention above.
  deps.app.on('window-all-closed', () => {
    if (shouldQuitOnAllWindowsClosed(deps.platform)) {
      deps.app.quit()
    }
  })

  // The throttled stateDoc persist may still have a pending write when the app
  // quits, so flush it and wait for storage to hit disk before the process
  // actually exits (otherwise recent grid/view changes are lost).
  deps.app.on('before-quit', (event) => {
    if (storageFlushed) {
      return
    }
    event.preventDefault()
    deps
      .flushStorage()
      .catch((err) => {
        log.error('Failed to flush storage before quit', err)
      })
      .finally(() => {
        storageFlushed = true
        deps.app.quit()
      })
  })
}

export interface StreamdelayPhaseDeps {
  config: StreamwallConfig['streamdelay']
  onState: (state: StreamwallState['streamdelay']) => void
  createClient?: (options: {
    endpoint: string
    key: string
  }) => StreamdelayClient
}

/**
 * Connects to Streamdelay when a key is configured. Returns `null` when the
 * integration is disabled.
 */
export function setupStreamdelayClient(
  deps: StreamdelayPhaseDeps,
): StreamdelayClient | null {
  const { key, endpoint } = deps.config
  if (!key) {
    return null
  }
  log.debug('Setting up Streamdelay client...')
  const create =
    deps.createClient ?? ((options) => new StreamdelayClient(options))
  const streamdelayClient = create({ endpoint, key })
  streamdelayClient.on('state', (state) => {
    deps.onState(state)
  })
  streamdelayClient.connect()
  return streamdelayClient
}

/** The bits of the state broadcaster the Twitch bot subscribes to. */
export interface StateEmitterLike {
  on(event: 'state', listener: (state: StreamwallState) => void): unknown
}

export interface TwitchBotPhaseDeps {
  config: StreamwallConfig['twitch']
  stateEmitter: StateEmitterLike
  getClientState: () => StreamwallState
  setListeningView: (idx: ViewId) => void
  createBot?: (options: ConstructorParameters<typeof TwitchBot>[0]) => TwitchBot
}

/**
 * Connects the Twitch chat bot when client id, token and channel are all
 * configured. Returns `null` when the integration is disabled.
 */
export function setupTwitchBot(deps: TwitchBotPhaseDeps): TwitchBot | null {
  const { 'client-id': clientId, token, channel } = deps.config
  if (!clientId || !token || !channel) {
    return null
  }
  log.debug('Setting up Twitch bot...')
  const create = deps.createBot ?? ((options) => new TwitchBot(options))
  const twitchBot = create({
    ...deps.config,
    'client-id': clientId,
    token,
    channel,
  })
  twitchBot.on('setListeningView', (idx) => {
    deps.setListeningView(idx)
  })
  deps.stateEmitter.on('state', () => twitchBot.onState(deps.getClientState()))
  twitchBot.connect()
  return twitchBot
}

/**
 * Builds the per-data-source health callback factory, folding every report
 * into the broadcast state.
 */
export function createDataSourceHealthReporter(
  updateState: (newState: Partial<StreamwallState>) => void,
) {
  const dataSourceHealthTracker = new DataSourceHealthTracker()
  return function trackDataSourceHealth(id: string, type: DataSourceType) {
    return (ok: boolean, message?: string) => {
      updateState({
        dataSourceHealth: dataSourceHealthTracker.report(id, type, ok, message),
      })
    }
  }
}

export interface SentryPhaseDeps {
  enabled: boolean
  dsn: string
  initSentry: (options: { dsn: string }) => void
  appendSwitch: (name: string, value: string) => void
  switchName: string
  switchValue: (enabled: boolean) => string
}

/**
 * Initializes Sentry in the main process and passes the opt-in down to every
 * Chromium subprocess.
 *
 * Sandboxed preload scripts (control, background, overlay) have no other
 * channel to this config, so it travels as a command-line switch every
 * subprocess receives -- see sentryConfig.ts and sentryPreload.ts.
 */
export function configureSentry(deps: SentryPhaseDeps): void {
  log.debug('Initializing Sentry...')
  if (deps.enabled) {
    deps.initSentry({ dsn: deps.dsn })
  }
  deps.appendSwitch(deps.switchName, deps.switchValue(deps.enabled))
}

export interface ElectronRuntimeDeps {
  appendSwitch: (name: string, value: string) => void
  enableSandbox: () => void
}

/** Applies the Chromium switches and sandbox mode the app requires. */
export function configureElectronRuntime(deps: ElectronRuntimeDeps): void {
  log.debug('Setting up Electron...')
  deps.appendSwitch('high-dpi-support', '1')
  deps.appendSwitch('force-device-scale-factor', '1')

  log.debug('Enabling Electron sandbox...')
  deps.enableSandbox()
}
