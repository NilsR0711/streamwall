import * as Sentry from '@sentry/electron/main'
import { BrowserWindow, app, shell } from 'electron'
import fs from 'fs'
import EventEmitter from 'node:events'
import { join } from 'node:path'
import 'source-map-support/register'
import { StreamwallState } from 'streamwall-shared'
import * as Y from 'yjs'
import packageJson from '../../package.json'
import {
  SENTRY_DSN,
  SENTRY_ENABLED_SWITCH,
  sentryEnabledSwitchValue,
} from '../sentryConfig'
import { parseRepositorySlug } from '../updateStatus'
import { createSessionHostResolver, ensureValidURL } from '../util'
import {
  configureElectronRuntime,
  configureSentry,
  createBrowseWindow,
  createDataSourceHealthReporter,
  createInitialClientState,
  createPersistedLocalStreamData,
  createStateDocPersister,
  restoreStateDoc,
  seedAndObserveViewsState,
  setupApplicationMenu,
  setupStreamdelayClient,
  setupTwitchBot,
  startPlaylistScheduler,
  wireWindowIpc,
  wireWindowLifecycle,
} from './bootstrap'
import { StreamwallConfig, parseArgs } from './cliArgs'
import { dispatchLocalCommand } from './commandDispatch'
import { createOnCommand } from './commandHandlers'
import { resolveConfigInitError } from './configInitError'
import ControlWindow from './ControlWindow'
import {
  CONTROL_WINDOW_ORIGIN,
  shouldForwardUpdateToControlWindow,
} from './controlWindowEcho'
import { LocalStreamData, StreamIDGenerator, combineDataSources } from './data'
import { buildDataSources } from './dataSources'
import log, { initLogger, setLogLevel } from './logger'
import { installApplicationMenu } from './menu'
import { denyWindowOpen } from './navigationSecurity'
import { BROWSE_PARTITION, hardenSession } from './partitions'
import { flushStorage, loadStorage, safeUpdate } from './storage'
import StreamdelayClient from './StreamdelayClient'
import StreamWindow from './StreamWindow'
import { setupAppUpdater } from './updaterSetup'
import { connectControlUplink } from './uplinkConnection'
import { deriveWallViews } from './wallViews'
import { buildRetryConfig, buildStreamWindowConfig } from './windowConfig'

async function main(argv: ReturnType<typeof parseArgs>) {
  const db = await loadStorage(
    join(app.getPath('userData'), 'streamwall-storage.json'),
  )

  const { userConfigPath, hasUserConfig } = setupApplicationMenu({
    userDataPath: app.getPath('userData'),
    logFilePath: log.transports.file.getFile().path,
    fileExists: (path) => fs.existsSync(path),
    installMenu: installApplicationMenu,
  })

  log.debug('Creating StreamWindow...')
  const idGen = new StreamIDGenerator()

  const localStreamData = createPersistedLocalStreamData({
    initialEntries: db.data.localStreamData,
    persistEntries: (entries) => {
      safeUpdate(db, (data) => {
        data.localStreamData = entries
      })
    },
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
  let clientState: StreamwallState = createInitialClientState({
    config: streamWindowConfig,
    layoutPresets: db.data.layoutPresets,
    favorites: db.data.favorites,
  })

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
    restoreStateDoc(stateDoc, db.data.stateDoc)
  }

  const persistStateDoc = createStateDocPersister({
    stateDoc,
    saveSnapshot: (encoded) => {
      safeUpdate(db, (data) => {
        data.stateDoc = encoded
      })
    },
  })

  seedAndObserveViewsState({
    viewsState,
    transact: (fn) => stateDoc.transact(fn),
    cols: argv.grid.cols,
    rows: argv.grid.rows,
    updateViews: updateViewsFromStateDoc,
  })

  const playlistScheduler = startPlaylistScheduler({
    playlists: argv.playlist,
    getStreams: () => clientState.streams,
    viewsState,
    transact: (fn) => stateDoc.transact(fn),
  })

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
    createBrowseWindow: () =>
      createBrowseWindow({
        createWindow: () =>
          new BrowserWindow({
            webPreferences: {
              nodeIntegration: false,
              contextIsolation: true,
              // Keep the operator's browsing isolated from the stream views and
              // off disk by using a dedicated ephemeral partition.
              partition: BROWSE_PARTITION,
              sandbox: true,
            },
          }),
        hardenSession,
        denyWindowOpen,
      }),
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
  wireWindowIpc({
    streamWindow,
    controlWindow,
    stateDoc,
    updateState,
    updateViewsFromStateDoc,
    getClientState: () => clientState,
    shouldForwardUpdate: shouldForwardUpdateToControlWindow,
    controlWindowOrigin: CONTROL_WINDOW_ORIGIN,
    handleCommand: (command) => dispatchLocalCommand(onCommand, command),
  })

  wireWindowLifecycle({
    app,
    platform: process.platform,
    streamWindow,
    controlWindow,
    flushStorage: () => flushStorage(db, () => persistStateDoc.flush()),
  })

  connectControlUplink({
    endpoint: argv.control.endpoint,
    stateDoc,
    stateEmitter,
    getClientState: () => clientState,
    onCommand,
  })

  streamdelayClient = setupStreamdelayClient({
    config: argv.streamdelay,
    onState: (state) => {
      updateState({ streamdelay: state })
    },
  })

  setupTwitchBot({
    config: argv.twitch,
    stateEmitter,
    getClientState: () => clientState,
    setListeningView: (idx) => {
      streamWindow.setListeningView(idx)
    },
  })

  const trackDataSourceHealth = createDataSourceHealthReporter(updateState)

  const dataSources = buildDataSources({
    jsonUrls: argv.data['json-url'],
    tomlFiles: argv.data['toml-file'],
    presets: argv.presets,
    interval: argv.data.interval,
    localStreamData,
    overlayStreamData,
    trackDataSourceHealth,
  })

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

  const appendSwitch = (name: string, value: string) => {
    app.commandLine.appendSwitch(name, value)
  }

  configureSentry({
    enabled: argv.telemetry.sentry,
    dsn: SENTRY_DSN,
    initSentry: (options) => Sentry.init(options),
    appendSwitch,
    switchName: SENTRY_ENABLED_SWITCH,
    switchValue: sentryEnabledSwitchValue,
  })

  configureElectronRuntime({
    appendSwitch,
    enableSandbox: () => app.enableSandbox(),
  })

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
