import * as Sentry from '@sentry/electron/main'
import { BrowserWindow, Event as ElectronEvent, app, shell } from 'electron'
import fs from 'fs'
import { throttle } from 'lodash-es'
import EventEmitter from 'node:events'
import { join } from 'node:path'
import 'source-map-support/register'
import { DataSourceType, StreamwallState } from 'streamwall-shared'
import * as Y from 'yjs'
import packageJson from '../../package.json'
import {
  SENTRY_DSN,
  SENTRY_ENABLED_SWITCH,
  sentryEnabledSwitchValue,
} from '../sentryConfig'
import { parseRepositorySlug } from '../updateStatus'
import { createSessionHostResolver, ensureValidURL } from '../util'
import { StreamwallConfig, parseArgs } from './cliArgs'
import { dispatchLocalCommand } from './commandDispatch'
import { createOnCommand } from './commandHandlers'
import { resolveConfigInitError } from './configInitError'
import ControlWindow from './ControlWindow'
import {
  CONTROL_WINDOW_ORIGIN,
  shouldForwardUpdateToControlWindow,
} from './controlWindowEcho'
import {
  LocalStreamData,
  OVERLAY_DATA_SOURCE_NAME,
  StreamIDGenerator,
  combineDataSources,
  markDataSource,
  pollDataURL,
  presetDataSource,
  watchDataFile,
} from './data'
import { DataSourceHealthTracker } from './dataSourceHealth'
import log, { initLogger, setLogLevel } from './logger'
import { installApplicationMenu } from './menu'
import { denyWindowOpen } from './navigationSecurity'
import { BROWSE_PARTITION, hardenSession } from './partitions'
import { PlaylistScheduler } from './playlist'
import { loadPresetPack } from './presets'
import { flushStorage, loadStorage, safeUpdate } from './storage'
import StreamdelayClient from './StreamdelayClient'
import StreamWindow from './StreamWindow'
import TwitchBot from './TwitchBot'
import { setupAppUpdater } from './updaterSetup'
import { connectControlUplink } from './uplinkConnection'
import { initializeViewsState } from './viewsStateInit'
import { deriveWallViews } from './wallViews'
import {
  shouldHideInsteadOfQuit,
  shouldQuitOnAllWindowsClosed,
} from './windowCloseBehavior'
import { buildRetryConfig, buildStreamWindowConfig } from './windowConfig'

async function main(argv: ReturnType<typeof parseArgs>) {
  const db = await loadStorage(
    join(app.getPath('userData'), 'streamwall-storage.json'),
  )

  // Recomputes the same path parseArgs() already read from - fs.existsSync
  // here (rather than threading a flag through the yargs config) keeps this
  // check local to where it's needed, for the "Open Config Folder" menu item
  // and the control UI's first-run hint (#86).
  const userConfigPath = join(app.getPath('userData'), 'config.toml')
  const hasUserConfig = fs.existsSync(userConfigPath)
  installApplicationMenu(
    userConfigPath,
    log.transports.file.getFile().path,
    hasUserConfig,
  )

  log.debug('Creating StreamWindow...')
  const idGen = new StreamIDGenerator()

  const localStreamData = new LocalStreamData(db.data.localStreamData)
  localStreamData.on('update', (entries) => {
    safeUpdate(db, (data) => {
      data.localStreamData = entries
    })
  })

  const overlayStreamData = new LocalStreamData()

  const streamWindowConfig = buildStreamWindowConfig(argv)
  const retryConfig = buildRetryConfig(argv)
  const streamWindow = new StreamWindow(
    streamWindowConfig,
    retryConfig,
    argv.park.pause,
  )
  const controlWindow = new ControlWindow({
    configPath: userConfigPath,
    hasUserConfig,
  })

  setupAppUpdater({
    platform: process.platform,
    isPackaged: app.isPackaged,
    currentVersion: app.getVersion(),
    repositorySlug: parseRepositorySlug(packageJson.repository),
    controlWindow,
    openExternal: (url) => shell.openExternal(url),
  })

  let streamdelayClient: StreamdelayClient | null = null

  log.debug('Creating initial state...')
  let clientState: StreamwallState = {
    identity: {
      role: 'local',
    },
    config: streamWindowConfig,
    streams: [],
    customStreams: [],
    views: [],
    fullscreenViewIdx: null,
    streamdelay: null,
    layoutPresets: db.data.layoutPresets,
    favorites: db.data.favorites,
    dataSourceHealth: [],
  }

  function updateViewsFromStateDoc() {
    try {
      const wallViews = deriveWallViews({
        fullscreenViewIdx: clientState.fullscreenViewIdx,
        streams: clientState.streams,
        viewsState,
        cols: streamWindowConfig.cols,
        rows: streamWindowConfig.rows,
      })
      if (wallViews.mode === 'fullscreen') {
        streamWindow.setViews(wallViews.contentMap, clientState.streams, {
          parkUnused: true,
        })
        return
      }
      // The expanded stream is gone: clear the stale override so clients stop
      // rendering a phantom expansion. The setViews() below emits a state
      // update that broadcasts the cleared value.
      if (wallViews.clearedFullscreen) {
        clientState = { ...clientState, fullscreenViewIdx: null }
      }
      streamWindow.setViews(wallViews.contentMap, clientState.streams)
    } catch (err) {
      log.error('Error updating views', err)
    }
  }

  const stateDoc = new Y.Doc()
  const viewsState = stateDoc.getMap<Y.Map<string | undefined>>('views')

  if (db.data.stateDoc) {
    log.info('Loading stateDoc from storage...')
    try {
      Y.applyUpdate(stateDoc, Buffer.from(db.data.stateDoc, 'base64'))
    } catch (err) {
      log.warn('Failed to restore stateDoc', err)
    }
  }

  const persistStateDoc = throttle(() => {
    safeUpdate(db, (data) => {
      const fullDoc = Y.encodeStateAsUpdate(stateDoc)
      data.stateDoc = Buffer.from(fullDoc).toString('base64')
    })
  }, 1000)
  stateDoc.on('update', persistStateDoc)

  initializeViewsState(
    { viewsState, transact: (fn) => stateDoc.transact(fn) },
    argv.grid.cols,
    argv.grid.rows,
  )

  updateViewsFromStateDoc()
  viewsState.observeDeep(updateViewsFromStateDoc)

  // Cycles any configured views through their playlist of stream URLs,
  // independent of whatever data source populated `clientState.streams`.
  const playlistScheduler = new PlaylistScheduler(argv.playlist, {
    resolveStreamId: (url) =>
      (
        clientState.streams.byURL?.get(url) ??
        clientState.streams.find((s) => s.link === url)
      )?._id,
    setViewStream: (view, streamId) => {
      stateDoc.transact(() => {
        viewsState.get(String(view))?.set('streamId', streamId)
      })
    },
  })
  playlistScheduler.start()

  const onCommand = createOnCommand({
    streamWindow,
    overlayStreamData,
    localStreamData,
    viewsState,
    transact: (fn) => stateDoc.transact(fn),
    streamWindowConfig,
    getClientState: () => clientState,
    getStreamdelayClient: () => streamdelayClient,
    updateState,
    updateViewsFromStateDoc,
    persistLayoutPresets: (layoutPresets) => {
      safeUpdate(db, (data) => {
        data.layoutPresets = layoutPresets
      })
    },
    persistFavorites: (favorites) => {
      safeUpdate(db, (data) => {
        data.favorites = favorites
      })
    },
    createBrowseWindow: () => {
      const win = new BrowserWindow({
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          // Keep the operator's browsing isolated from the stream views and
          // off disk by using a dedicated ephemeral partition.
          partition: BROWSE_PARTITION,
          sandbox: true,
        },
      })
      hardenSession(win.webContents.session)
      // Deny popups; the browse window is meant to show a single URL.
      denyWindowOpen(win.webContents)
      return win
    },
    validateBrowseURL: (url, browseWindow) =>
      ensureValidURL(
        url,
        createSessionHostResolver(browseWindow.webContents.session),
      ),
  })

  const stateEmitter = new EventEmitter<{ state: [StreamwallState] }>()

  function updateState(newState: Partial<StreamwallState>) {
    clientState = { ...clientState, ...newState }
    streamWindow.onState(clientState)
    controlWindow.onState(clientState)
    stateEmitter.emit('state', clientState)
  }

  // Wire up IPC:

  // StreamWindow view updates -> main
  streamWindow.on('state', (viewStates) => {
    updateState({ views: viewStates })
  })

  // StreamWindow resized -> re-layout stream views and rebroadcast state so the
  // overlay grid matches the new window dimensions.
  streamWindow.on('resize', () => {
    updateViewsFromStateDoc()
    updateState({})
  })

  // StreamWindow <- main init state
  streamWindow.on('load', () => {
    streamWindow.onState(clientState)
  })

  // Control <- main collab updates
  stateDoc.on('update', (update, origin) => {
    if (!shouldForwardUpdateToControlWindow(origin)) {
      return
    }
    controlWindow.onYDocUpdate(update)
  })

  // Control <- main init state
  controlWindow.on('load', () => {
    controlWindow.onState(clientState)
    controlWindow.onYDocUpdate(Y.encodeStateAsUpdate(stateDoc))
  })

  // Control -> main
  controlWindow.on('ydoc', (update) =>
    Y.applyUpdate(stateDoc, update, CONTROL_WINDOW_ORIGIN),
  )
  controlWindow.setCommandHandler((command) =>
    dispatchLocalCommand(onCommand, command),
  )

  // Closing either top-level window quits the app, except on macOS where the
  // convention is to hide the window and keep the app (and its dock icon)
  // running until the user explicitly quits.
  let isQuitting = false
  let storageFlushed = false
  app.on('before-quit', () => {
    isQuitting = true
  })
  app.on('activate', () => {
    streamWindow.win.show()
    controlWindow.win.show()
  })

  function handleWindowClose(win: BrowserWindow, event: ElectronEvent) {
    if (shouldHideInsteadOfQuit(process.platform, isQuitting)) {
      event.preventDefault()
      win.hide()
      return
    }
    app.quit()
  }
  streamWindow.on('close', (event) =>
    handleWindowClose(streamWindow.win, event),
  )
  controlWindow.on('close', (event) =>
    handleWindowClose(controlWindow.win, event),
  )

  // Standard Electron convention as a safety net: if every window somehow
  // ends up closed without the app already quitting (e.g. a future window
  // added without wiring into the close handling above), quit rather than
  // linger as a windowless background process. macOS is excluded, matching
  // the hide-instead-of-quit convention above.
  app.on('window-all-closed', () => {
    if (shouldQuitOnAllWindowsClosed(process.platform)) {
      app.quit()
    }
  })

  // The throttled stateDoc persist above may still have a pending write when
  // the app quits, so flush it and wait for storage to hit disk before the
  // process actually exits (otherwise recent grid/view changes are lost).
  app.on('before-quit', (event) => {
    if (storageFlushed) {
      return
    }
    event.preventDefault()
    flushStorage(db, () => persistStateDoc.flush())
      .catch((err) => {
        log.error('Failed to flush storage before quit', err)
      })
      .finally(() => {
        storageFlushed = true
        app.quit()
      })
  })

  connectControlUplink({
    endpoint: argv.control.endpoint,
    stateDoc,
    stateEmitter,
    getClientState: () => clientState,
    onCommand,
  })

  if (argv.streamdelay.key) {
    log.debug('Setting up Streamdelay client...')
    streamdelayClient = new StreamdelayClient({
      endpoint: argv.streamdelay.endpoint,
      key: argv.streamdelay.key,
    })
    streamdelayClient.on('state', (state) => {
      updateState({ streamdelay: state })
    })
    streamdelayClient.connect()
  }

  const {
    username: twitchUsername,
    token: twitchToken,
    channel: twitchChannel,
  } = argv.twitch
  if (twitchUsername && twitchToken && twitchChannel) {
    log.debug('Setting up Twitch bot...')
    const twitchBot = new TwitchBot({
      ...argv.twitch,
      username: twitchUsername,
      token: twitchToken,
      channel: twitchChannel,
    })
    twitchBot.on('setListeningView', (idx) => {
      streamWindow.setListeningView(idx)
    })
    stateEmitter.on('state', () => twitchBot.onState(clientState))
    twitchBot.connect()
  }

  const dataSourceHealthTracker = new DataSourceHealthTracker()
  function trackDataSourceHealth(id: string, type: DataSourceType) {
    return (ok: boolean, message?: string) => {
      updateState({
        dataSourceHealth: dataSourceHealthTracker.report(id, type, ok, message),
      })
    }
  }

  const dataSources = [
    ...argv.data['json-url'].map((url) => {
      log.debug('Setting data source from json-url:', url)
      return markDataSource(
        pollDataURL(
          url,
          argv.data.interval,
          trackDataSourceHealth(url, 'json-url'),
        ),
        'json-url',
      )
    }),
    ...argv.data['toml-file'].map((path) => {
      log.debug('Setting data source from toml-file:', path)
      return markDataSource(
        watchDataFile(path, trackDataSourceHealth(path, 'toml-file')),
        'toml-file',
      )
    }),
    ...argv.presets.flatMap((packId) => {
      const pack = loadPresetPack(packId)
      if (!pack) {
        log.warn(`Unknown preset pack "${packId}", skipping`)
        return []
      }
      log.debug('Loading preset pack:', pack.id)
      return [markDataSource(presetDataSource(pack), `preset:${pack.id}`)]
    }),
    markDataSource(localStreamData.gen(), 'custom'),
    markDataSource(overlayStreamData.gen(), OVERLAY_DATA_SOURCE_NAME),
  ]

  for await (const streams of combineDataSources(dataSources, idGen)) {
    updateState({ streams })
    updateViewsFromStateDoc()
    // Newly-loaded stream data may resolve a playlist URL that failed to
    // resolve on startup or a prior interval tick; fill it in immediately
    // rather than leaving the view empty until the next tick.
    playlistScheduler.retryPending()
  }
}

function init() {
  initLogger()
  log.debug('Parsing command line arguments...')
  let argv: StreamwallConfig
  try {
    argv = parseArgs({
      configDir: app.getPath('userData'),
      argv: process.argv,
    })
  } catch (err) {
    const outcome = resolveConfigInitError(err)
    if (outcome.action === 'exit') {
      // Surface the offending file/key/line cleanly instead of a stack trace.
      log.error(outcome.message)
      process.exit(outcome.exitCode)
    }
    throw err
  }
  setLogLevel(argv.log.level)
  if (argv.help) {
    return
  }

  log.debug('Initializing Sentry...')
  if (argv.telemetry.sentry) {
    Sentry.init({ dsn: SENTRY_DSN })
  }
  // Sandboxed preload scripts (control, background, overlay) have no other
  // channel to this config, so pass it down as a command-line switch every
  // Chromium subprocess receives -- see sentryConfig.ts and sentryPreload.ts.
  app.commandLine.appendSwitch(
    SENTRY_ENABLED_SWITCH,
    sentryEnabledSwitchValue(argv.telemetry.sentry),
  )

  log.debug('Setting up Electron...')
  app.commandLine.appendSwitch('high-dpi-support', '1')
  app.commandLine.appendSwitch('force-device-scale-factor', '1')

  log.debug('Enabling Electron sandbox...')
  app.enableSandbox()

  app
    .whenReady()
    .then(() => main(argv))
    .catch((err) => {
      log.error(err)
      process.exit(1)
    })
}

log.debug('Starting Streamwall...')
init()
