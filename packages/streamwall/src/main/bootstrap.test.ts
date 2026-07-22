import EventEmitter from 'node:events'
import { join } from 'node:path'
import type { StreamwallState, ViewId } from 'streamwall-shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import {
  type LifecycleApp,
  type LifecycleWindow,
  type PreventableEvent,
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
import type { StreamwallConfig } from './cliArgs'
import log from './logger'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function fakeStreamwallState(
  overrides: Partial<StreamwallState> = {},
): StreamwallState {
  return {
    ...createInitialClientState({
      config: { width: 0, height: 0, x: 0, y: 0, cols: 2, rows: 2 },
      layoutPresets: [],
      favorites: [],
    }),
    ...overrides,
  }
}

describe('setupApplicationMenu', () => {
  it('resolves the user config path inside the userData directory', () => {
    const installMenu = vi.fn()
    const result = setupApplicationMenu({
      userDataPath: '/user/data',
      logFilePath: '/logs/main.log',
      fileExists: () => true,
      installMenu,
    })

    expect(result).toEqual({
      userConfigPath: join('/user/data', 'config.toml'),
      hasUserConfig: true,
    })
    expect(installMenu).toHaveBeenCalledWith(
      join('/user/data', 'config.toml'),
      '/logs/main.log',
      true,
    )
  })

  it('reports a missing user config to the menu', () => {
    const installMenu = vi.fn()
    const result = setupApplicationMenu({
      userDataPath: '/user/data',
      logFilePath: '/logs/main.log',
      fileExists: () => false,
      installMenu,
    })

    expect(result.hasUserConfig).toBe(false)
    expect(installMenu).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      false,
    )
  })
})

describe('createPersistedLocalStreamData', () => {
  it('seeds from stored entries and persists later updates', () => {
    const persistEntries = vi.fn()
    const localStreamData = createPersistedLocalStreamData({
      initialEntries: [{ link: 'http://a.test/', kind: 'video' }],
      persistEntries,
    })

    expect(localStreamData.dataByURL.get('http://a.test/')).toBeDefined()
    expect(persistEntries).not.toHaveBeenCalled()

    localStreamData.update('http://b.test/', { kind: 'video' })

    expect(persistEntries).toHaveBeenCalledTimes(1)
    const entries = persistEntries.mock.calls[0][0]
    expect(entries.map((entry: { link?: string }) => entry.link)).toContain(
      'http://b.test/',
    )
  })
})

describe('createInitialClientState', () => {
  it('carries the persisted presets and favorites into a local identity', () => {
    const state = createInitialClientState({
      config: { width: 1, height: 2, x: 3, y: 4, cols: 3, rows: 2 },
      layoutPresets: [],
      favorites: [],
    })

    expect(state.identity).toEqual({ role: 'local' })
    expect(state.config.cols).toBe(3)
    expect(state.streams).toEqual([])
    expect(state.fullscreenViewIdx).toBeNull()
    expect(state.streamdelay).toBeNull()
    expect(state.dataSourceHealth).toEqual([])
  })
})

describe('restoreStateDoc', () => {
  it('applies a stored snapshot', () => {
    const source = new Y.Doc()
    source.getMap('views').set('0', 'stored')
    const encoded = Buffer.from(Y.encodeStateAsUpdate(source)).toString(
      'base64',
    )

    const target = new Y.Doc()
    restoreStateDoc(target, encoded)

    expect(target.getMap('views').get('0')).toBe('stored')
  })

  it('keeps startup alive when the snapshot is corrupt', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined)
    const target = new Y.Doc()

    expect(() => {
      restoreStateDoc(target, 'bm90LWEteWpzLXVwZGF0ZQ==')
    }).not.toThrow()
    expect(warn).toHaveBeenCalled()
  })
})

describe('createStateDocPersister', () => {
  it('throttles snapshot writes and can flush a pending one', () => {
    vi.useFakeTimers()
    const stateDoc = new Y.Doc()
    const saveSnapshot = vi.fn()
    const persist = createStateDocPersister({
      stateDoc,
      saveSnapshot,
      wait: 1000,
    })

    stateDoc.getMap('views').set('0', 'a')
    stateDoc.getMap('views').set('1', 'b')
    expect(saveSnapshot).toHaveBeenCalledTimes(1)

    persist.flush()
    expect(saveSnapshot).toHaveBeenCalledTimes(2)

    const restored = new Y.Doc()
    const lastCall = saveSnapshot.mock.calls.at(-1)
    Y.applyUpdate(restored, Buffer.from(String(lastCall?.[0]), 'base64'))
    expect(restored.getMap('views').get('1')).toBe('b')
  })
})

describe('seedAndObserveViewsState', () => {
  it('seeds every grid cell before rendering the wall once', () => {
    const stateDoc = new Y.Doc()
    const viewsState = stateDoc.getMap<Y.Map<string | undefined>>('views')
    const seenCellCounts: number[] = []
    const updateViews = vi.fn(() => {
      seenCellCounts.push(viewsState.size)
    })

    seedAndObserveViewsState({
      viewsState,
      transact: (fn) => stateDoc.transact(fn),
      cols: 2,
      rows: 2,
      updateViews,
    })

    // The seeding transaction must complete before the first render, and the
    // observer must not fire during it -- exactly one render for four cells.
    expect(updateViews).toHaveBeenCalledTimes(1)
    expect(seenCellCounts).toEqual([4])
  })

  it('re-renders the wall on later view edits', () => {
    const stateDoc = new Y.Doc()
    const viewsState = stateDoc.getMap<Y.Map<string | undefined>>('views')
    const updateViews = vi.fn()

    seedAndObserveViewsState({
      viewsState,
      transact: (fn) => stateDoc.transact(fn),
      cols: 1,
      rows: 1,
      updateViews,
    })
    updateViews.mockClear()

    stateDoc.transact(() => {
      viewsState.get('0')?.set('streamId', 'stream-1')
    })

    expect(updateViews).toHaveBeenCalledTimes(1)
  })
})

describe('startPlaylistScheduler', () => {
  it('advances a configured view onto its playlist stream', () => {
    vi.useFakeTimers()
    const stateDoc = new Y.Doc()
    const viewsState = stateDoc.getMap<Y.Map<string | undefined>>('views')
    viewsState.set('0', new Y.Map<string | undefined>())
    const streams = [
      { _id: 'stream-1', link: 'http://a.test/' },
    ] as unknown as StreamwallState['streams']

    const scheduler = startPlaylistScheduler({
      playlists: [{ view: 0, interval: 1, urls: ['http://a.test/'] }],
      getStreams: () => streams,
      viewsState,
      transact: (fn) => stateDoc.transact(fn),
    })

    try {
      vi.advanceTimersByTime(1000)
      expect(viewsState.get('0')?.get('streamId')).toBe('stream-1')
    } finally {
      scheduler.stop()
    }
  })
})

describe('createBrowseWindow', () => {
  it('hardens the session and denies popups before handing the window over', () => {
    const order: string[] = []
    const win = { webContents: { session: 'session' } }
    const result = createBrowseWindow({
      createWindow: () => {
        order.push('create')
        return win
      },
      hardenSession: (session) => {
        order.push(`harden:${session}`)
      },
      denyWindowOpen: () => {
        order.push('deny')
      },
    })

    expect(result).toBe(win)
    expect(order).toEqual(['create', 'harden:session', 'deny'])
  })
})

/** A stand-in for StreamWindow/ControlWindow's typed event emitters. */
class FakeWindow extends EventEmitter {
  win = { show: vi.fn(), hide: vi.fn() }
  onState = vi.fn()
  onYDocUpdate = vi.fn()
  setCommandHandler = vi.fn()
}

describe('wireWindowIpc', () => {
  function wire() {
    const streamWindow = new FakeWindow()
    const controlWindow = new FakeWindow()
    const stateDoc = new Y.Doc()
    const clientState = fakeStreamwallState()
    const updateState = vi.fn()
    const updateViewsFromStateDoc = vi.fn()
    const handleCommand = vi.fn(async () => undefined)
    const controlWindowOrigin = Symbol('control')

    wireWindowIpc({
      streamWindow,
      controlWindow,
      stateDoc,
      updateState,
      updateViewsFromStateDoc,
      getClientState: () => clientState,
      shouldForwardUpdate: (origin) => origin !== controlWindowOrigin,
      controlWindowOrigin,
      handleCommand,
    })

    return {
      streamWindow,
      controlWindow,
      stateDoc,
      clientState,
      updateState,
      updateViewsFromStateDoc,
      handleCommand,
      controlWindowOrigin,
    }
  }

  it('broadcasts stream window view states', () => {
    const { streamWindow, updateState } = wire()
    streamWindow.emit('state', ['view'])
    expect(updateState).toHaveBeenCalledWith({ views: ['view'] })
  })

  it('re-lays out and rebroadcasts on resize', () => {
    const { streamWindow, updateState, updateViewsFromStateDoc } = wire()
    streamWindow.emit('resize')
    expect(updateViewsFromStateDoc).toHaveBeenCalledTimes(1)
    expect(updateState).toHaveBeenCalledWith({})
  })

  it('sends the current state to each window as it loads', () => {
    const { streamWindow, controlWindow, clientState } = wire()

    streamWindow.emit('load')
    expect(streamWindow.onState).toHaveBeenCalledWith(clientState)

    controlWindow.emit('load')
    expect(controlWindow.onState).toHaveBeenCalledWith(clientState)
    expect(controlWindow.onYDocUpdate).toHaveBeenCalledTimes(1)
  })

  it('echoes local doc updates to the control window but not its own', () => {
    const { stateDoc, controlWindow, controlWindowOrigin } = wire()

    stateDoc.getMap('views').set('0', 'local')
    expect(controlWindow.onYDocUpdate).toHaveBeenCalledTimes(1)

    controlWindow.onYDocUpdate.mockClear()
    stateDoc.transact(() => {
      stateDoc.getMap('views').set('1', 'echo')
    }, controlWindowOrigin)
    expect(controlWindow.onYDocUpdate).not.toHaveBeenCalled()
  })

  it('applies control window doc updates to the shared doc', () => {
    const { stateDoc, controlWindow } = wire()
    const source = new Y.Doc()
    source.getMap('views').set('0', 'from-control')

    controlWindow.emit('ydoc', Y.encodeStateAsUpdate(source))

    expect(stateDoc.getMap('views').get('0')).toBe('from-control')
  })

  it('registers the control command handler', () => {
    const { controlWindow, handleCommand } = wire()
    expect(controlWindow.setCommandHandler).toHaveBeenCalledWith(handleCommand)
  })
})

/** Records the app-level listeners `wireWindowLifecycle` registers. */
class FakeApp extends EventEmitter implements LifecycleApp {
  quit = vi.fn()
}

function preventableEvent(): PreventableEvent & { prevented: boolean } {
  const event = {
    prevented: false,
    preventDefault: () => {
      event.prevented = true
    },
  }
  return event
}

describe('wireWindowLifecycle', () => {
  function wire(
    platform: NodeJS.Platform,
    flushStorage = vi.fn(async () => undefined),
  ) {
    const app = new FakeApp()
    const streamWindow = new FakeWindow()
    const controlWindow = new FakeWindow()
    wireWindowLifecycle({
      app,
      platform,
      streamWindow: streamWindow as unknown as LifecycleWindow,
      controlWindow: controlWindow as unknown as LifecycleWindow,
      flushStorage,
    })
    return { app, streamWindow, controlWindow, flushStorage }
  }

  it('hides windows instead of quitting on macOS', () => {
    const { app, streamWindow } = wire('darwin')
    const event = preventableEvent()

    streamWindow.emit('close', event)

    expect(event.prevented).toBe(true)
    expect(streamWindow.win.hide).toHaveBeenCalled()
    expect(app.quit).not.toHaveBeenCalled()
  })

  it('quits when a window closes on other platforms', () => {
    const { app, controlWindow } = wire('linux')
    const event = preventableEvent()

    controlWindow.emit('close', event)

    expect(event.prevented).toBe(false)
    expect(controlWindow.win.hide).not.toHaveBeenCalled()
    expect(app.quit).toHaveBeenCalled()
  })

  it('quits on macOS once the user has asked to quit', () => {
    const { app, streamWindow } = wire('darwin')

    app.emit('before-quit', preventableEvent())
    const event = preventableEvent()
    streamWindow.emit('close', event)

    expect(event.prevented).toBe(false)
    expect(app.quit).toHaveBeenCalled()
  })

  it('reopens both windows on activate', () => {
    const { app, streamWindow, controlWindow } = wire('darwin')
    app.emit('activate')
    expect(streamWindow.win.show).toHaveBeenCalled()
    expect(controlWindow.win.show).toHaveBeenCalled()
  })

  it('quits when every window closed, except on macOS', () => {
    const linux = wire('linux')
    linux.app.emit('window-all-closed')
    expect(linux.app.quit).toHaveBeenCalled()

    const mac = wire('darwin')
    mac.app.emit('window-all-closed')
    expect(mac.app.quit).not.toHaveBeenCalled()
  })

  it('defers the first quit until storage is flushed, then quits once', async () => {
    let resolveFlush: () => void = () => undefined
    const flushStorage = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFlush = resolve
        }),
    )
    const { app } = wire('linux', flushStorage)

    const firstQuit = preventableEvent()
    app.emit('before-quit', firstQuit)
    expect(firstQuit.prevented).toBe(true)
    expect(flushStorage).toHaveBeenCalledTimes(1)
    expect(app.quit).not.toHaveBeenCalled()

    resolveFlush()
    await vi.waitFor(() => {
      expect(app.quit).toHaveBeenCalledTimes(1)
    })

    // The quit triggered by the flush must pass straight through.
    const secondQuit = preventableEvent()
    app.emit('before-quit', secondQuit)
    expect(secondQuit.prevented).toBe(false)
    expect(flushStorage).toHaveBeenCalledTimes(1)
  })

  it('still quits when flushing storage fails', async () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined)
    const { app } = wire(
      'linux',
      vi.fn(async () => {
        throw new Error('disk full')
      }),
    )

    app.emit('before-quit', preventableEvent())

    await vi.waitFor(() => {
      expect(app.quit).toHaveBeenCalledTimes(1)
    })
    expect(error).toHaveBeenCalled()
  })
})

describe('setupStreamdelayClient', () => {
  const config: StreamwallConfig['streamdelay'] = {
    endpoint: 'http://localhost:8404',
    key: null,
  }

  it('stays disabled without a key', () => {
    const createClient = vi.fn()
    expect(
      setupStreamdelayClient({
        config,
        onState: vi.fn(),
        createClient,
      }),
    ).toBeNull()
    expect(createClient).not.toHaveBeenCalled()
  })

  it('connects and forwards status updates when a key is configured', () => {
    const client = Object.assign(new EventEmitter(), { connect: vi.fn() })
    const onState = vi.fn()

    const result = setupStreamdelayClient({
      config: { ...config, key: 'secret' },
      onState,
      createClient: () => client as never,
    })

    expect(result).toBe(client)
    expect(client.connect).toHaveBeenCalledTimes(1)

    client.emit('state', { isCensored: true })
    expect(onState).toHaveBeenCalledWith({ isCensored: true })
  })
})

describe('setupTwitchBot', () => {
  const config = {
    channel: null,
    'client-id': null,
    token: null,
    color: '#ff0000',
    announce: { template: '', interval: 0, delay: 0 },
    vote: { template: '', interval: 0 },
  } as unknown as StreamwallConfig['twitch']

  it('stays disabled unless channel, client id and token are all set', () => {
    const createBot = vi.fn()
    expect(
      setupTwitchBot({
        config: { ...config, 'client-id': 'id', token: 'token' },
        stateEmitter: new EventEmitter(),
        getClientState: fakeStreamwallState,
        setListeningView: vi.fn(),
        createBot,
      }),
    ).toBeNull()
    expect(createBot).not.toHaveBeenCalled()
  })

  it('connects and relays state and listening-view changes', () => {
    const bot = Object.assign(new EventEmitter(), {
      connect: vi.fn(),
      onState: vi.fn(),
    })
    const stateEmitter = new EventEmitter()
    const setListeningView = vi.fn()
    const clientState = fakeStreamwallState()

    const result = setupTwitchBot({
      config: {
        ...config,
        channel: 'chan',
        'client-id': 'id',
        token: 'token',
      },
      stateEmitter,
      getClientState: () => clientState,
      setListeningView,
      createBot: () => bot as never,
    })

    expect(result).toBe(bot)
    expect(bot.connect).toHaveBeenCalledTimes(1)

    bot.emit('setListeningView', 2 as unknown as ViewId)
    expect(setListeningView).toHaveBeenCalledWith(2)

    stateEmitter.emit('state')
    expect(bot.onState).toHaveBeenCalledWith(clientState)
  })
})

describe('createDataSourceHealthReporter', () => {
  it('folds every report into the broadcast state', () => {
    const updateState = vi.fn()
    const track = createDataSourceHealthReporter(updateState)

    track('source-a', 'json')(false, 'timed out')

    expect(updateState).toHaveBeenCalledTimes(1)
    const health = updateState.mock.calls[0][0].dataSourceHealth
    expect(health).toEqual([
      expect.objectContaining({
        id: 'source-a',
        type: 'json',
        status: 'error',
        message: 'timed out',
      }),
    ])
  })
})

describe('configureSentry', () => {
  function run(enabled: boolean) {
    const initSentry = vi.fn()
    const appendSwitch = vi.fn()
    configureSentry({
      enabled,
      dsn: 'https://dsn.test/1',
      initSentry,
      appendSwitch,
      switchName: 'sentry-enabled',
      switchValue: (value) => (value ? '1' : '0'),
    })
    return { initSentry, appendSwitch }
  }

  it('initializes Sentry and passes the opt-in to subprocesses', () => {
    const { initSentry, appendSwitch } = run(true)
    expect(initSentry).toHaveBeenCalledWith({ dsn: 'https://dsn.test/1' })
    expect(appendSwitch).toHaveBeenCalledWith('sentry-enabled', '1')
  })

  it('still passes the opt-out switch when telemetry is disabled', () => {
    const { initSentry, appendSwitch } = run(false)
    expect(initSentry).not.toHaveBeenCalled()
    expect(appendSwitch).toHaveBeenCalledWith('sentry-enabled', '0')
  })
})

describe('configureElectronRuntime', () => {
  it('applies the display switches before enabling the sandbox', () => {
    const order: string[] = []
    configureElectronRuntime({
      appendSwitch: (name, value) => {
        order.push(`${name}=${value}`)
      },
      enableSandbox: () => {
        order.push('sandbox')
      },
    })

    expect(order).toEqual([
      'high-dpi-support=1',
      'force-device-scale-factor=1',
      'sandbox',
    ])
  })
})
