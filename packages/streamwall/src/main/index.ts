import * as Sentry from '@sentry/electron/main'
import { BrowserWindow, Event as ElectronEvent, app } from 'electron'
import started from 'electron-squirrel-startup'
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
  UplinkErrorReason,
  isCommandAllowedFromUplink,
  isSecureControlEndpoint,
  isSocketOpen,
  parseControlEndpoint,
  parseUplinkError,
} from 'streamwall-shared'
import { updateElectronApp } from 'update-electron-app'
import WebSocket from 'ws'
import yargs from 'yargs'
import * as Y from 'yjs'
import {
  SENTRY_DSN,
  SENTRY_ENABLED_SWITCH,
  sentryEnabledSwitchValue,
} from '../sentryConfig'
import { createSessionHostResolver, ensureValidURL } from '../util'
import {
  ConfigError,
  findUnknownConfigKeys,
  parseConfigToml,
  validateConfig,
} from './config'
import ControlWindow from './ControlWindow'
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
import log, { initLogger } from './logger'
import { installApplicationMenu } from './menu'
import { denyWindowOpen } from './navigationSecurity'
import { BROWSE_PARTITION, hardenSession } from './partitions'
import { PlaylistScheduler } from './playlist'
import { loadPresetPack } from './presets'
import { flushStorage, loadStorage, safeUpdate } from './storage'
import StreamdelayClient from './StreamdelayClient'
import StreamWindow from './StreamWindow'
import TwitchBot from './TwitchBot'
import { initializeViewsState } from './viewsStateInit'
import {
  shouldHideInsteadOfQuit,
  shouldQuitOnAllWindowsClosed,
} from './windowCloseBehavior'

/**
 * Human-readable explanation logged when the control server refuses the uplink
 * connection. These `{error: '...'}` messages carry no command `type`, so
 * without this they would otherwise be logged by `onCommand` as a misleading
 * "disallowed command: undefined" (issue #300).
 */
const UPLINK_ERROR_MESSAGE: Record<UplinkErrorReason, string> = {
  unauthorized:
    'the control server rejected the uplink token (invalid or expired)',
  'already-connected':
    'another Streamwall instance is already connected to the control server',
}

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

export interface StreamwallConfig {
  help: boolean
  grid: {
    cols: number
    rows: number
  }
  window: {
    x?: number
    y?: number
    width: number
    height: number
    frameless: boolean
    fullscreen: boolean
    display?: number
    'background-color': string
    'active-color': string
  }
  data: {
    interval: number
    'json-url': string[]
    'toml-file': string[]
  }
  presets: string[]
  streamdelay: {
    endpoint: string
    key: string | null
  }
  control: {
    endpoint: string
  }
  retry: {
    enabled: boolean
    delay: number
    'max-delay': number
    'max-retries': number
    'stalled-timeout': number
  }
  twitch: {
    channel: string | null
    username: string | null
    token: string | null
    color: string
    announce: {
      template: string
      interval: number
      delay: number
    }
    vote: {
      template: string
      interval: number
    }
  }
  telemetry: {
    sentry: boolean
  }
  playlist: {
    view: number
    interval: number
    urls: string[]
  }[]
}

// Warns (does not throw) about keys in a raw parsed config file that the
// schema doesn't recognize — typos and stale keys (e.g. the removed
// `grid.count`) that would otherwise be silently dropped and fall back to
// defaults with no indication anything was wrong.
function warnUnknownConfigKeys(raw: unknown, source: string) {
  for (const key of findUnknownConfigKeys(raw)) {
    log.warn(`Unknown config key "${key}" in "${source}" is ignored.`)
  }
}

function parseArgs(): StreamwallConfig {
  // Load config from user data dir, if it exists
  const configPath = join(app.getPath('userData'), 'config.toml')
  log.debug('Reading config from ', configPath)

  let configText: string | null = null
  try {
    configText = fs.readFileSync(configPath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err
    }
  }

  const homeConfig = configText ? parseConfigToml(configText, configPath) : {}
  if (configText) {
    warnUnknownConfigKeys(homeConfig, configPath)
  }

  const argv = yargs()
    .config(homeConfig)
    .config('config', (configFilePath) => {
      const config = parseConfigToml(
        fs.readFileSync(configFilePath, 'utf-8'),
        configFilePath,
      )
      warnUnknownConfigKeys(config, configFilePath)
      return config
    })
    .group(['grid.cols', 'grid.rows'], 'Grid dimensions')
    .option('grid.cols', {
      number: true,
      default: 3,
    })
    .option('grid.rows', {
      number: true,
      default: 3,
    })
    .group(
      [
        'window.width',
        'window.height',
        'window.x',
        'window.y',
        'window.frameless',
        'window.fullscreen',
        'window.display',
        'window.background-color',
        'window.active-color',
      ],
      'Window settings',
    )
    .option('window.x', {
      number: true,
    })
    .option('window.y', {
      number: true,
    })
    .option('window.width', {
      number: true,
      default: 1920,
    })
    .option('window.height', {
      number: true,
      default: 1080,
    })
    .option('window.frameless', {
      boolean: true,
      default: false,
    })
    .option('window.fullscreen', {
      describe: 'Open the wall fullscreen (on the selected display, if any)',
      boolean: true,
      default: false,
    })
    .option('window.display', {
      describe:
        'Index of the display to open the wall on (0-based; see --window.fullscreen)',
      number: true,
    })
    .option('window.background-color', {
      describe: 'Background color of wall (useful for chroma-keying)',
      default: '#000',
    })
    .option('window.active-color', {
      describe: 'Active (highlight) color of wall',
      default: '#fff',
    })
    .group(['data.interval', 'data.json-url', 'data.toml-file'], 'Datasources')
    .option('data.interval', {
      describe: 'Interval (in seconds) for refreshing polled data sources',
      number: true,
      default: 30,
    })
    .option('data.json-url', {
      describe: 'Fetch streams from the specified URL(s)',
      array: true,
      string: true,
      default: [],
    })
    .option('data.toml-file', {
      describe: 'Fetch streams from the specified file(s)',
      normalize: true,
      array: true,
      default: [],
    })
    .group(['presets'], 'Presets')
    .option('presets', {
      describe: 'Enabled built-in preset stream packs (e.g. "de-tv")',
      array: true,
      string: true,
      default: ['de-tv'],
    })
    .group(['streamdelay.endpoint', 'streamdelay.key'], 'Streamdelay')
    .option('streamdelay.endpoint', {
      describe: 'URL of Streamdelay endpoint',
      default: 'http://localhost:8404',
    })
    .option('streamdelay.key', {
      describe: 'Streamdelay API key',
      default: null,
    })
    .group(['control'], 'Remote Control')
    .option('control.endpoint', {
      describe: 'URL of control server endpoint',
      default: null,
    })
    .group(
      [
        'retry.enabled',
        'retry.delay',
        'retry.max-delay',
        'retry.max-retries',
        'retry.stalled-timeout',
      ],
      'Auto-retry',
    )
    .option('retry.enabled', {
      describe: 'Automatically reload views that error or stall',
      boolean: true,
      default: true,
    })
    .option('retry.delay', {
      describe: 'Base backoff (in seconds) before the first reload',
      number: true,
      default: 5,
    })
    .option('retry.max-delay', {
      describe: 'Maximum backoff (in seconds) between reloads',
      number: true,
      default: 60,
    })
    .option('retry.max-retries', {
      describe: 'Maximum number of automatic reloads before giving up',
      number: true,
      default: 5,
    })
    .option('retry.stalled-timeout', {
      describe: 'How long (in seconds) a view may stall before it is reloaded',
      number: true,
      default: 30,
    })
    .group(
      [
        'twitch.channel',
        'twitch.username',
        'twitch.token',
        'twitch.color',
        'twitch.announce.template',
        'twitch.announce.interval',
        'twitch.vote.template',
        'twitch.vote.interval',
      ],
      'Twitch Chat',
    )
    .option('twitch.channel', {
      describe: 'Name of Twitch channel',
      default: null,
    })
    .option('twitch.username', {
      describe: 'Username of Twitch bot account',
      default: null,
    })
    .option('twitch.token', {
      describe: 'Password of Twitch bot account',
      default: null,
    })
    .option('twitch.color', {
      describe: 'Color of Twitch bot username',
      default: '#ff0000',
    })
    .option('twitch.announce.template', {
      describe: 'Message template for stream announcements',
      default:
        'SingsMic <%- stream.source %> <%- stream.city && stream.state ? `(${stream.city} ${stream.state})` : `` %> <%- stream.link %>',
    })
    .option('twitch.announce.interval', {
      describe:
        'Minimum time interval (in seconds) between re-announcing the same stream',
      number: true,
      default: 60,
    })
    .option('twitch.announce.delay', {
      describe: 'Time to dwell on a stream before its details are announced',
      number: true,
      default: 30,
    })
    .option('twitch.vote.template', {
      describe: 'Message template for vote result announcements',
      default: 'Switching to #<%- selectedIdx %> (with <%- voteCount %> votes)',
    })
    .option('twitch.vote.interval', {
      describe: 'Time interval (in seconds) between votes (0 to disable)',
      number: true,
      default: 0,
    })
    .group(['telemetry.sentry'], 'Telemetry')
    .option('telemetry.sentry', {
      describe: 'Enable error reporting to Sentry',
      boolean: true,
      default: true,
    })
    // Configured only via `[[playlist]]` tables in config.toml (or --config);
    // not exposed as an individual CLI flag since it's a list of tables.
    .option('playlist', {
      default: [],
    })
    .help()
    // https://github.com/yargs/yargs/issues/2137
    .parseSync(process.argv) as unknown as StreamwallConfig

  // Skip validation when the user only asked for --help, so an invalid config
  // can never block the help text from being shown.
  if (!argv.help) {
    validateConfig(argv)
  }
  return argv
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
  installApplicationMenu(userConfigPath, log.transports.file.getFile().path)

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
  const streamWindow = new StreamWindow(streamWindowConfig, retryConfig)
  const controlWindow = new ControlWindow({
    configPath: userConfigPath,
    hasUserConfig,
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
    streamdelay: null,
    layoutPresets: db.data.layoutPresets,
    favorites: db.data.favorites,
    dataSourceHealth: [],
  }

  function updateViewsFromStateDoc() {
    try {
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
  ) => {
    log.debug('Received message:', msg)

    // The remote control-server uplink is untrusted: re-validate every command
    // against the uplink allowlist so a compromised or man-in-the-middled
    // server cannot drive code execution (browse/dev-tools) on the desktop.
    if (source === 'uplink') {
      const type = (msg as { type?: unknown } | null)?.type
      if (typeof type !== 'string' || !isCommandAllowedFromUplink(type)) {
        log.warn('Rejecting disallowed command from control uplink:', type)
        return
      }
    }

    if (msg.type === 'set-listening-view') {
      log.debug('Setting listening view:', msg.viewIdx)
      streamWindow.setListeningView(msg.viewIdx)
    } else if (msg.type === 'set-view-background-listening') {
      log.debug(
        'Setting view background listening:',
        msg.viewIdx,
        msg.listening,
      )
      streamWindow.setViewBackgroundListening(msg.viewIdx, msg.listening)
    } else if (msg.type === 'set-view-blurred') {
      log.debug('Setting view blurred:', msg.viewIdx, msg.blurred)
      streamWindow.setViewBlurred(msg.viewIdx, msg.blurred)
    } else if (msg.type === 'set-view-volume') {
      log.debug('Setting view volume:', msg.viewIdx, msg.volume)
      streamWindow.setViewVolume(msg.viewIdx, msg.volume)
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
      log.debug('Reloading view:', msg.viewIdx)
      streamWindow.reloadView(msg.viewIdx)
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
        }
      } else if (msg.type === 'dev-tools') {
        log.debug('Opening DevTools for view:', msg.viewIdx)
        streamWindow.openDevTools(msg.viewIdx, browseWindow.webContents)
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
  stateDoc.on('update', (update) => {
    controlWindow.onYDocUpdate(update)
  })

  // Control <- main init state
  controlWindow.on('load', () => {
    controlWindow.onState(clientState)
    controlWindow.onYDocUpdate(Y.encodeStateAsUpdate(stateDoc))
  })

  // Control -> main
  controlWindow.on('ydoc', (update) => Y.applyUpdate(stateDoc, update))
  controlWindow.on('command', (command) => onCommand(command, 'local'))

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

  if (
    argv.control.endpoint &&
    !isSecureControlEndpoint(argv.control.endpoint)
  ) {
    log.error(
      `Refusing to connect to insecure control endpoint "${argv.control.endpoint}". ` +
        'The control connection must use wss:// (or ws:// to a loopback host).',
    )
  } else if (argv.control.endpoint) {
    log.debug('Connecting to control server...')
    // Move the uplink secret out of the URL query string and into an
    // Authorization header so it never reaches server or proxy access logs.
    const { url: controlURL, authorization } = parseControlEndpoint(
      argv.control.endpoint,
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
      if (ev.data instanceof ArrayBuffer) {
        Y.applyUpdate(stateDoc, new Uint8Array(ev.data))
        return
      }

      let msg
      try {
        msg = JSON.parse(ev.data)
      } catch (err) {
        log.warn('Failed to parse control WebSocket message:', err)
        return
      }

      // The server sends `{error: '...'}` right before closing the uplink when
      // it refuses the connection. These carry no command `type`, so surface
      // the real reason here instead of letting onCommand's uplink allowlist
      // reject them as a "disallowed command: undefined" (issue #300).
      const uplinkError = parseUplinkError(msg)
      if (uplinkError) {
        log.warn(
          'Control server refused the uplink connection:',
          UPLINK_ERROR_MESSAGE[uplinkError],
        )
        return
      }

      onCommand(msg, 'uplink')
    })
    stateEmitter.on('state', () => {
      if (!isSocketOpen(ws)) {
        return
      }
      ws.send(JSON.stringify({ type: 'state', state: clientState }))
    })
    stateDoc.on('update', (update) => {
      if (!isSocketOpen(ws)) {
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
  }
}

function init() {
  initLogger()
  log.debug('Parsing command line arguments...')
  let argv: ReturnType<typeof parseArgs>
  try {
    argv = parseArgs()
  } catch (err) {
    if (err instanceof ConfigError) {
      // Surface the offending file/key/line cleanly instead of a stack trace.
      log.error(err.message)
      process.exit(1)
    }
    throw err
  }
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

  updateElectronApp()

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

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit()
}

log.debug('Starting Streamwall...')
init()
