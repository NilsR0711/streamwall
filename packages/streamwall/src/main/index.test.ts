import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * `main()` (index.ts) has zero exports -- it is the Electron entry point,
 * loaded only by forge.config.ts, and every ordering guard it relies on lives
 * inside the phase functions it calls (see bootstrap.ts). Nothing exercised
 * `main()` itself, so swapping two phase calls went completely unnoticed
 * (issue #598): Electron startup is order-sensitive and this is the repo's
 * highest-churn file.
 *
 * This test imports index.ts for its side effect (it calls `init()` at
 * module scope) with every startup collaborator stubbed, including the whole
 * `./bootstrap` module, and asserts the exact order its 14 startup-time
 * phase calls happen in. `createBrowseWindow`, the bootstrap module's 15th
 * export, is registered as an on-demand callback rather than invoked during
 * startup, so it is intentionally not part of the asserted sequence.
 */

const mocks = vi.hoisted(() => {
  return {
    bootstrap: {
      setupApplicationMenu: vi.fn(() => ({
        userConfigPath: '/fake/config.toml',
        hasUserConfig: false,
      })),
      // Only `.gen()` matters: `main()` feeds it straight into
      // `buildDataSources`, which reads `.gen()` eagerly but never iterates
      // it (that happens inside the mocked `combineDataSources`).
      createPersistedLocalStreamData: vi.fn(() => ({
        gen: () => (async function* () {})(),
      })),
      createInitialClientState: vi.fn(() => ({
        identity: { role: 'local' },
        config: { width: 0, height: 0, x: 0, y: 0, cols: 2, rows: 2 },
        streams: [],
        customStreams: [],
        views: [],
        fullscreenViewIdx: null,
        streamdelay: null,
        layoutPresets: [],
        favorites: [],
        dataSourceHealth: [],
      })),
      restoreStateDoc: vi.fn(),
      createStateDocPersister: vi.fn(() => Object.assign(vi.fn(), { flush: vi.fn() })),
      seedAndObserveViewsState: vi.fn(),
      startPlaylistScheduler: vi.fn(() => ({
        start: vi.fn(),
        retryPending: vi.fn(),
      })),
      wireWindowIpc: vi.fn(),
      wireWindowLifecycle: vi.fn(),
      setupStreamdelayClient: vi.fn(() => null),
      setupTwitchBot: vi.fn(() => null),
      createDataSourceHealthReporter: vi.fn(() => vi.fn(() => vi.fn())),
      createBrowseWindow: vi.fn(),
      configureSentry: vi.fn(),
      configureElectronRuntime: vi.fn(),
    },
    parseArgs: vi.fn(() => ({
      help: false,
      log: { level: 'error' },
      grid: { cols: 2, rows: 2 },
      window: {
        width: 100,
        height: 100,
        frameless: false,
        fullscreen: false,
        'background-color': '#000000',
        'active-color': '#ffffff',
      },
      data: { interval: 60, 'json-url': [], 'toml-file': [] },
      presets: [],
      streamdelay: { endpoint: '', key: null },
      control: { endpoint: '' },
      retry: {
        enabled: false,
        delay: 1,
        'max-delay': 1,
        'max-retries': 1,
        'stalled-timeout': 1,
      },
      park: { pause: false },
      twitch: {
        channel: null,
        'client-id': null,
        token: null,
        color: '',
        announce: { template: '', interval: 1, delay: 1 },
        vote: { template: '', interval: 1 },
      },
      telemetry: { sentry: false },
      playlist: [],
    })),
    loadStorage: vi.fn(async () => ({
      data: {
        // A non-empty stateDoc makes `restoreStateDoc` actually run, so its
        // position in the sequence is exercised rather than skipped.
        stateDoc: 'ZmFrZQ==',
        localStreamData: [],
        layoutPresets: [],
        favorites: [],
      },
    })),
    flushStorage: vi.fn(async () => {}),
    safeUpdate: vi.fn(async () => {}),
    setupAppUpdater: vi.fn(),
    connectControlUplink: vi.fn(),
    createOnCommand: vi.fn(() => ({})),
  }
})

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/fake/userData'),
    getVersion: vi.fn(() => '0.0.0-test'),
    isPackaged: false,
    commandLine: { appendSwitch: vi.fn() },
    enableSandbox: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
    on: vi.fn(),
    quit: vi.fn(),
  },
  BrowserWindow: class FakeBrowserWindow {},
  shell: { openExternal: vi.fn() },
}))

vi.mock('@sentry/electron/main', () => ({
  init: vi.fn(),
}))

vi.mock('./bootstrap', () => mocks.bootstrap)

vi.mock('./cliArgs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./cliArgs')>()
  return { ...actual, parseArgs: mocks.parseArgs }
})

vi.mock('./storage', () => ({
  loadStorage: mocks.loadStorage,
  flushStorage: mocks.flushStorage,
  safeUpdate: mocks.safeUpdate,
}))

vi.mock('./ControlWindow', () => ({
  default: class FakeControlWindow {},
}))

vi.mock('./StreamWindow', () => ({
  default: class FakeStreamWindow {},
}))

vi.mock('./updaterSetup', () => ({
  setupAppUpdater: mocks.setupAppUpdater,
}))

vi.mock('./uplinkConnection', () => ({
  connectControlUplink: mocks.connectControlUplink,
}))

vi.mock('./commandHandlers', () => ({
  createOnCommand: mocks.createOnCommand,
}))

vi.mock('./logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./logger')>()
  return {
    ...actual,
    default: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      transports: { file: { getFile: () => ({ path: '/fake/main.log' }) } },
    },
    initLogger: vi.fn(),
    setLogLevel: vi.fn(),
  }
})

vi.mock('./data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./data')>()
  return {
    ...actual,
    // Real LocalStreamData/StreamIDGenerator are cheap, side-effect-free
    // classes constructed directly in main(); combineDataSources is the one
    // piece that would otherwise block main()'s `for await` loop forever, so
    // it alone is replaced with a generator that finishes immediately.
    combineDataSources: vi.fn(async function* () {}),
  }
})

/**
 * The exact order `main()`/`init()` invoke the 14 bootstrap phases that run
 * during a normal startup, written out explicitly so a future reordering
 * produces a readable diff (`expected[i] !== actual[i]`) instead of a
 * cryptic assertion failure.
 */
const EXPECTED_PHASE_ORDER = [
  'configureSentry',
  'configureElectronRuntime',
  'setupApplicationMenu',
  'createPersistedLocalStreamData',
  'createInitialClientState',
  'restoreStateDoc',
  'createStateDocPersister',
  'seedAndObserveViewsState',
  'startPlaylistScheduler',
  'wireWindowIpc',
  'wireWindowLifecycle',
  'setupStreamdelayClient',
  'setupTwitchBot',
  'createDataSourceHealthReporter',
] as const

/** Reads the call order of the tracked bootstrap phases off their mocks. */
function actualPhaseOrder(): string[] {
  const calls: { name: string; order: number }[] = []
  for (const name of EXPECTED_PHASE_ORDER) {
    const fn = mocks.bootstrap[name as keyof typeof mocks.bootstrap]
    const order = fn.mock.invocationCallOrder[0]
    if (order !== undefined) {
      calls.push({ name, order })
    }
  }
  calls.sort((a, b) => a.order - b.order)
  return calls.map((c) => c.name)
}

afterEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
})

describe('main() startup sequence', () => {
  it('invokes the bootstrap phases in the documented order', async () => {
    // A guard against an actual startup failure surfacing as a hard process
    // exit instead of a readable assertion failure below.
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never)

    await import('./index')

    await vi.waitFor(() => {
      expect(mocks.bootstrap.createDataSourceHealthReporter).toHaveBeenCalled()
    })

    expect(exitSpy).not.toHaveBeenCalled()
    expect(actualPhaseOrder()).toEqual(EXPECTED_PHASE_ORDER)
  })
})
