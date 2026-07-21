import * as Sentry from '@sentry/electron/main'
import { BrowserWindow, Event as ElectronEvent, app, shell } from 'electron'
import fs from 'fs'
import { throttle } from 'lodash-es'
import { randomUUID } from 'node:crypto'
import EventEmitter from 'node:events'
import { join } from 'node:path'
import ReconnectingWebSocket from 'reconnecting-websocket'
import 'source-map-support/register'
import {
  ControlCommand,
  DataSourceType,
  StreamwallState,
  fullscreenViewContentMap,
  isSocketOpen,
  parseControlEndpoint,
} from 'streamwall-shared'
import WebSocket from 'ws'
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
import { dispatchCommand, dispatchLocalCommand } from './commandDispatch'
import { resolveConfigInitError } from './configInitError'
import { decideControlEndpointConnection } from './controlEndpointConnection'
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
import { addFavorite, removeFavorite } from './favorites'
import { applyGridResize } from './gridResize'
import {
  addLayoutPreset,
  applyLayoutPreset,
  buildLayoutPreset,
} from './layoutPresets'
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
import { checkUplinkCommandGate } from './uplinkCommandGate'
import { UPLINK_ORIGIN, shouldForwardUpdateToUplink } from './uplinkEcho'
import { routeUplinkWsMessage } from './uplinkMessageRouting'
import { initializeViewsState } from './viewsStateInit'
import {
  shouldHideInsteadOfQuit,
  shouldQuitOnAllWindowsClosed,
} from './windowCloseBehavior'

/**
 * Builds a WebSocket subclass for the control uplink.
 *
 * It enforces TLS certificate validation on wss:// connections: together with
 * the wss:// requirement on the control endpoint, this authenticates the
 * control server to the desktop and prevents a man-in-the-middle from
 * impersonating it. `rejectUnauthorized` defaults to true in `ws`, but we set
 * it explicitly so the guarantee cannot be silently lost to a future change.
 *
 * It also injects the uplink credential as an `Authorization` header rather
 * than a URL query parameter, keeping the secret out of server and proxy
 * access logs. `reconnecting-websocket` does not forward constructor options,
 * so the header is baked into the subclass here.
 */
function makeControlWebSocket(authorization: string | null) {
  return class ControlWebSocket extends WebSocket {
    constructor(url: string, protocols?: string | string[]) {
      super(url, protocols, {
        rejectUnauthorized: true,
        headers: authorization ? { authorization } : undefined,
      })
    }
  }
}

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

  const streamWindowConfig = {
    cols: argv.grid.cols,
    rows: argv.grid.rows,
    width: argv.window.width,
    height: argv.window.height,
    x: argv.window.x,
    y: argv.window.y,
    frameless: argv.window.frameless,
    fullscreen: argv.window.fullscreen,
    display: argv.window.display,
    activeColor: argv.window['active-color'],
    backgroundColor: argv.window['background-color'],
  }
  // The state machine works in milliseconds; the config is in seconds for
  // consistency with the other interval options.
  const retryConfig = {
    enabled: argv.retry.enabled,
    delay: argv.retry.delay * 1000,
    maxDelay: argv.retry['max-delay'] * 1000,
    maxRetries: argv.retry['max-retries'],
    stalledTimeout: argv.retry['stalled-timeout'] * 1000,
  }
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

  let browseWindow: BrowserWindow | null = null
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
      // When a view is expanded to fullscreen (issue #362), override the
      // derived layout so the expanded stream fills every grid cell -- one
      // wall-spanning box, with the other views parked (hidden but kept
      // alive, not torn down) behind it, so a later collapse can reposition
      // them instead of reloading them from scratch (issue #369). This
      // override is transient: it reads the expanded stream from
      // `viewsState` but never writes back, so the persisted grid
      // assignments are untouched and a later collapse restores the normal
      // layout verbatim.
      const { fullscreenViewIdx } = clientState
      if (fullscreenViewIdx != null) {
        const streamId = viewsState
          .get(String(fullscreenViewIdx))
          ?.get('streamId')
        const stream = clientState.streams.find((s) => s._id === streamId)
        if (stream) {
          streamWindow.setViews(
            fullscreenViewContentMap(
              streamWindowConfig.cols,
              streamWindowConfig.rows,
              { url: stream.link, kind: stream.kind || 'video' },
            ),
            clientState.streams,
            { parkUnused: true },
          )
          return
        }
        // The expanded stream is gone (its cell was cleared or it dropped out
        // of the data source): fall back to the normal layout and clear the
        // stale override so clients stop rendering a phantom expansion. The
        // setViews() below emits a state update that broadcasts the cleared
        // value.
        clientState = { ...clientState, fullscreenViewIdx: null }
      }
      const viewContentMap = new Map()
      for (const [key, viewData] of viewsState) {
        const streamId = viewData.get('streamId')
        const stream = clientState.streams.find((s) => s._id === streamId)
        if (!stream) {
          continue
        }
        viewContentMap.set(key, {
          url: stream.link,
          kind: stream.kind || 'video',
        })
      }
      streamWindow.setViews(viewContentMap, clientState.streams)
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

  const onCommand = async (
    msg: ControlCommand,
    source: 'local' | 'uplink' = 'local',
  ): Promise<{ error: string } | void> => {
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

    if (msg.type === 'set-listening-view') {
      log.debug('Setting listening view:', msg.viewId)
      streamWindow.setListeningView(msg.viewId)
    } else if (msg.type === 'set-view-background-listening') {
      log.debug('Setting view background listening:', msg.viewId, msg.listening)
      streamWindow.setViewBackgroundListening(msg.viewId, msg.listening)
    } else if (msg.type === 'set-view-blurred') {
      log.debug('Setting view blurred:', msg.viewId, msg.blurred)
      streamWindow.setViewBlurred(msg.viewId, msg.blurred)
    } else if (msg.type === 'set-view-volume') {
      log.debug('Setting view volume:', msg.viewId, msg.volume)
      streamWindow.setViewVolume(msg.viewId, msg.volume)
    } else if (msg.type === 'rotate-stream') {
      log.debug('Rotating stream:', msg.url, msg.rotation)
      overlayStreamData.update(msg.url, {
        rotation: msg.rotation,
      })
    } else if (msg.type === 'update-custom-stream') {
      log.debug('Updating custom stream:', msg.url)
      localStreamData.update(msg.url, msg.data)
    } else if (msg.type === 'delete-custom-stream') {
      log.debug('Deleting custom stream:', msg.url)
      localStreamData.delete(msg.url)
    } else if (msg.type === 'reload-view') {
      log.debug('Reloading view:', msg.viewId)
      streamWindow.reloadView(msg.viewId)
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
      updateState({
        fullscreenViewIdx: msg.fullscreen
          ? streamWindow.getViewAnchorIdx(msg.viewId)
          : null,
      })
      updateViewsFromStateDoc()
    } else if (msg.type === 'browse' || msg.type === 'dev-tools') {
      if (browseWindow && !browseWindow.isDestroyed()) {
        // DevTools needs a fresh webContents to work. Close any existing window.
        browseWindow.destroy()
        browseWindow = null
      }
      if (!browseWindow || browseWindow.isDestroyed()) {
        browseWindow = new BrowserWindow({
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            // Keep the operator's browsing isolated from the stream views and
            // off disk by using a dedicated ephemeral partition.
            partition: BROWSE_PARTITION,
            sandbox: true,
          },
        })
        hardenSession(browseWindow.webContents.session)
        // Deny popups; the browse window is meant to show a single URL.
        denyWindowOpen(browseWindow.webContents)
      }
      if (msg.type === 'browse') {
        log.debug('Attempting to browse URL:', msg.url)
        try {
          await ensureValidURL(
            msg.url,
            createSessionHostResolver(browseWindow.webContents.session),
          )
          browseWindow.loadURL(msg.url)
        } catch (error) {
          log.error('Invalid URL:', msg.url)
          log.error('Error:', error)
          return { error: 'invalid url' }
        }
      } else if (msg.type === 'dev-tools') {
        log.debug('Opening DevTools for view:', msg.viewId)
        streamWindow.openDevTools(msg.viewId, browseWindow.webContents)
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
          viewsState,
          transact: (fn) => stateDoc.transact(fn),
          getCols: () => streamWindowConfig.cols,
          getRows: () => streamWindowConfig.rows,
          setGridSize: (cols, rows) => streamWindow.setGridSize(cols, rows),
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
      updateState({})
    } else if (msg.type === 'save-layout-preset') {
      log.debug('Saving layout preset:', msg.name)
      const preset = buildLayoutPreset(
        {
          viewsState,
          cols: streamWindowConfig.cols,
          rows: streamWindowConfig.rows,
        },
        randomUUID(),
        msg.name,
      )
      const layoutPresets = addLayoutPreset(clientState.layoutPresets, preset)
      safeUpdate(db, (data) => {
        data.layoutPresets = layoutPresets
      })
      updateState({ layoutPresets })
    } else if (msg.type === 'load-layout-preset') {
      const preset = clientState.layoutPresets.find(
        (p) => p.id === msg.presetId,
      )
      if (preset) {
        log.debug('Loading layout preset:', preset.name)
        applyLayoutPreset(
          {
            viewsState,
            transact: (fn) => stateDoc.transact(fn),
            setGridSize: (cols, rows) => streamWindow.setGridSize(cols, rows),
          },
          preset,
        )
        // See the set-grid-size branch above: broadcast the shared config
        // object via updateState({}) rather than detaching a copy.
        updateState({})
      }
    } else if (msg.type === 'delete-layout-preset') {
      log.debug('Deleting layout preset:', msg.presetId)
      const layoutPresets = clientState.layoutPresets.filter(
        (p) => p.id !== msg.presetId,
      )
      safeUpdate(db, (data) => {
        data.layoutPresets = layoutPresets
      })
      updateState({ layoutPresets })
    } else if (msg.type === 'add-favorite') {
      const favorites = addFavorite(clientState.favorites, msg.url)
      if (favorites !== clientState.favorites) {
        log.debug('Adding favorite:', msg.url)
        safeUpdate(db, (data) => {
          data.favorites = favorites
        })
        updateState({ favorites })
      }
    } else if (msg.type === 'remove-favorite') {
      const favorites = removeFavorite(clientState.favorites, msg.url)
      if (favorites !== clientState.favorites) {
        log.debug('Removing favorite:', msg.url)
        safeUpdate(db, (data) => {
          data.favorites = favorites
        })
        updateState({ favorites })
      }
    }
  }

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

  const controlConnection = decideControlEndpointConnection(
    argv.control.endpoint,
  )
  if (
    controlConnection.action === 'skip' &&
    controlConnection.reason === 'insecure'
  ) {
    log.error(
      `Refusing to connect to insecure control endpoint "${controlConnection.endpoint}". ` +
        'The control connection must use wss:// (or ws:// to a loopback host).',
    )
  } else if (controlConnection.action === 'connect') {
    log.debug('Connecting to control server...')
    // Move the uplink secret out of the URL query string and into an
    // Authorization header so it never reaches server or proxy access logs.
    const { url: controlURL, authorization } = parseControlEndpoint(
      controlConnection.endpoint,
    )
    const ws = new ReconnectingWebSocket(controlURL, [], {
      WebSocket: makeControlWebSocket(authorization),
      maxReconnectionDelay: 5000,
      minReconnectionDelay: 100 + Math.random() * 500,
      reconnectionDelayGrowFactor: 1.25,
      // The 'open' handler below always re-sends the full client state and
      // Yjs doc as soon as the connection (re)opens, so anything sent while
      // disconnected is stale by the time it could be delivered. Disable the
      // library's default unbounded queue rather than let it buffer full
      // state snapshots for as long as the control server is unreachable.
      maxEnqueuedMessages: 0,
    })
    ws.binaryType = 'arraybuffer'
    ws.addEventListener('open', () => {
      log.debug('Control WebSocket connected.')
      ws.send(JSON.stringify({ type: 'state', state: clientState }))
      ws.send(Y.encodeStateAsUpdate(stateDoc))
    })
    ws.addEventListener('close', () => {
      log.debug('Control WebSocket disconnected.')
    })
    ws.addEventListener('message', (ev) => {
      const route = routeUplinkWsMessage(ev.data)
      switch (route.kind) {
        case 'yjs-update':
          Y.applyUpdate(stateDoc, route.update, UPLINK_ORIGIN)
          return
        case 'parse-error':
          log.warn('Failed to parse control WebSocket message:', route.error)
          return
        case 'uplink-error':
          log.warn(
            'Control server refused the uplink connection:',
            route.message,
          )
          return
        case 'command':
          dispatchCommand(onCommand, route.message as ControlCommand, 'uplink')
      }
    })
    stateEmitter.on('state', () => {
      if (!isSocketOpen(ws)) {
        return
      }
      ws.send(JSON.stringify({ type: 'state', state: clientState }))
    })
    stateDoc.on('update', (update, origin) => {
      if (!shouldForwardUpdateToUplink(origin) || !isSocketOpen(ws)) {
        return
      }
      ws.send(update)
    })
  }

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
