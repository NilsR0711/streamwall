import EventEmitter from 'events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ControlWindow pulls in Electron directly and via ./loadHTML. Model
// BrowserWindow as a small EventEmitter so `win.on('close', ...)` wiring can
// be exercised the same way the real window would drive it, without an
// Electron runtime.
interface NavEvent {
  url: string
  preventDefault(): void
}

// Stands in for the window's WebContents. `setWindowOpenHandler` and the
// navigation listeners are recorded rather than mocked away, so the navigation
// hardening the constructor installs (#732) can be driven from a test.
class FakeWebContents {
  send = vi.fn()
  openDevTools = vi.fn()
  windowOpenHandler: ((details: { url: string }) => { action: string }) | null =
    null
  navHandlers: Record<string, Array<(event: NavEvent) => void>> = {}

  on(event: string, listener: (event: NavEvent) => void): this {
    const handlers = this.navHandlers[event] ?? []
    handlers.push(listener)
    this.navHandlers[event] = handlers
    return this
  }

  setWindowOpenHandler(
    handler: (details: { url: string }) => { action: string },
  ) {
    this.windowOpenHandler = handler
  }

  // Dispatches a navigation event and reports whether a guard cancelled it.
  dispatchNavigation(event: string, url: string): boolean {
    let prevented = false
    const navEvent: NavEvent = {
      url,
      preventDefault: () => {
        prevented = true
      },
    }
    for (const listener of this.navHandlers[event] ?? []) {
      listener(navEvent)
    }
    return prevented
  }
}

class FakeBrowserWindow extends EventEmitter {
  webContents = new FakeWebContents()
  removeMenu = vi.fn()
  options: Record<string, unknown>

  constructor(options: Record<string, unknown>) {
    super()
    this.options = options
  }
}

type IpcHandler = (event: { sender: unknown }, ...args: unknown[]) => unknown

const ipcHandlers = new Map<string, IpcHandler>()
const handle = vi.fn((channel: string, handler: IpcHandler) => {
  ipcHandlers.set(channel, handler)
})
const openPath = vi.fn()
// Resolves like the real shell.openExternal so the caller's `.catch`
// breadcrumb has something to attach to.
const openExternal = vi.fn(() => Promise.resolve())

vi.mock('electron', () => ({
  BrowserWindow: FakeBrowserWindow,
  ipcMain: { handle },
  shell: { openPath, openExternal },
}))

// `loadHTML` returns a resolved promise like the real one, so the caller's
// `.catch` breadcrumb (issue #626) has something to attach to. `isAppPageURL`
// stands in for the real app-page allowlist, whose answer depends on
// build-time Vite globals; here the window's own page is the only app URL.
const APP_PAGE = 'file:///app/renderer/control.html'
vi.mock('./loadHTML', () => ({
  loadHTML: vi.fn(() => Promise.resolve()),
  isAppPageURL: (url: string) => url === APP_PAGE,
}))

const createExampleConfig = vi.fn()
vi.mock('./exampleConfig', () => ({ createExampleConfig }))

const { default: ControlWindow } = await import('./ControlWindow')

const configInfo = {
  configPath: '/home/test/.config/Streamwall/config.toml',
  hasUserConfig: false,
}

// Every test constructs its own ControlWindow, so the registration history has
// to start empty rather than accumulating across the file.
beforeEach(() => {
  openExternal.mockClear()
  handle.mockClear()
})

describe('ControlWindow close', () => {
  it('forwards the underlying Electron close event so callers can preventDefault', () => {
    const controlWindow = new ControlWindow(configInfo)
    const closeListener = vi.fn()
    controlWindow.on('close', closeListener)

    const fakeEvent = { preventDefault: vi.fn() }
    controlWindow.win.emit('close', fakeEvent)

    expect(closeListener).toHaveBeenCalledWith(fakeEvent)
  })

  it('keeps the native close control enabled so the quit/hide behavior wired through the close event is reachable from the window chrome', () => {
    const controlWindow = new ControlWindow(configInfo)

    expect(
      (controlWindow.win as unknown as FakeBrowserWindow).options.closable,
    ).not.toBe(false)
  })

  it('does not strip the window menu, so the app-level "Open Config Folder" menu item stays reachable on Windows/Linux', () => {
    const controlWindow = new ControlWindow(configInfo)

    expect(
      (controlWindow.win as unknown as FakeBrowserWindow).removeMenu,
    ).not.toHaveBeenCalled()
  })
})

describe('ControlWindow first-run info', () => {
  it('returns the config path/existence to the renderer that owns the window', () => {
    const controlWindow = new ControlWindow(configInfo)
    const sender = (controlWindow.win as unknown as FakeBrowserWindow)
      .webContents

    const result = ipcHandlers.get('control:first-run-info')!({ sender })

    expect(result).toEqual(configInfo)
  })

  it('ignores requests from a sender other than its own window', () => {
    const controlWindow = new ControlWindow(configInfo)
    void controlWindow

    const result = ipcHandlers.get('control:first-run-info')!({
      sender: { send: vi.fn() },
    })

    expect(result).toBeUndefined()
  })
})

describe('ControlWindow create-example-config', () => {
  it('delegates to createExampleConfig with the configured path', () => {
    const controlWindow = new ControlWindow(configInfo)
    const sender = (controlWindow.win as unknown as FakeBrowserWindow)
      .webContents

    ipcHandlers.get('control:create-example-config')!({ sender })

    expect(createExampleConfig).toHaveBeenCalledWith(configInfo.configPath)
  })

  it('propagates errors (e.g. a file already existing) to the caller instead of swallowing them', () => {
    const controlWindow = new ControlWindow(configInfo)
    const sender = (controlWindow.win as unknown as FakeBrowserWindow)
      .webContents
    const err = new Error('EEXIST: file already exists')
    createExampleConfig.mockImplementationOnce(() => {
      throw err
    })

    expect(() =>
      ipcHandlers.get('control:create-example-config')!({ sender }),
    ).toThrow(err)
  })

  it('ignores requests from a sender other than its own window', () => {
    const controlWindow = new ControlWindow(configInfo)
    void controlWindow
    createExampleConfig.mockClear()

    ipcHandlers.get('control:create-example-config')!({
      sender: { send: vi.fn() },
    })

    expect(createExampleConfig).not.toHaveBeenCalled()
  })
})

describe('ControlWindow open-config-folder', () => {
  it('opens the directory containing the config file', () => {
    const controlWindow = new ControlWindow(configInfo)
    const sender = (controlWindow.win as unknown as FakeBrowserWindow)
      .webContents

    ipcHandlers.get('control:open-config-folder')!({ sender })

    expect(openPath).toHaveBeenCalledWith('/home/test/.config/Streamwall')
  })

  it('ignores requests from a sender other than its own window', () => {
    const controlWindow = new ControlWindow(configInfo)
    void controlWindow
    openPath.mockClear()

    ipcHandlers.get('control:open-config-folder')!({
      sender: { send: vi.fn() },
    })

    expect(openPath).not.toHaveBeenCalled()
  })
})

describe('ControlWindow command IPC', () => {
  it('returns an error response from the registered handler to the renderer', async () => {
    const controlWindow = new ControlWindow(configInfo)
    const sender = (controlWindow.win as unknown as FakeBrowserWindow)
      .webContents
    controlWindow.setCommandHandler(async () => ({ error: 'invalid url' }))

    const result = await ipcHandlers.get('control:command')!(
      { sender },
      { type: 'browse', url: 'file:///etc/passwd' },
    )

    expect(result).toEqual({ error: 'invalid url' })
  })

  it('returns undefined when the handler succeeds', async () => {
    const controlWindow = new ControlWindow(configInfo)
    const sender = (controlWindow.win as unknown as FakeBrowserWindow)
      .webContents
    controlWindow.setCommandHandler(async () => undefined)

    const result = await ipcHandlers.get('control:command')!(
      { sender },
      { type: 'set-grid-size', cols: 2, rows: 2 },
    )

    expect(result).toBeUndefined()
  })

  it('ignores requests from a sender other than its own window', async () => {
    const controlWindow = new ControlWindow(configInfo)
    const handler = vi.fn().mockResolvedValue({ error: 'nope' })
    controlWindow.setCommandHandler(handler)

    const result = await ipcHandlers.get('control:command')!(
      { sender: { send: vi.fn() } },
      { type: 'ping' },
    )

    expect(result).toBeUndefined()
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('ControlWindow update notifications', () => {
  it('pushes update status to the renderer so the banner can react without polling', () => {
    const controlWindow = new ControlWindow(configInfo)
    const { webContents } = controlWindow.win as unknown as FakeBrowserWindow

    controlWindow.onUpdateStatus({
      state: 'downloading',
      version: '0.9.2',
      progress: null,
    })

    expect(webContents.send).toHaveBeenCalledWith('update-status', {
      state: 'downloading',
      version: '0.9.2',
      progress: null,
    })
  })

  it('serves the current status on request, so a renderer that mounts late is not stuck on idle', async () => {
    const controlWindow = new ControlWindow(configInfo)
    const sender = (controlWindow.win as unknown as FakeBrowserWindow)
      .webContents
    const status = {
      state: 'ready' as const,
      version: '0.9.2',
      releaseNotesUrl: null,
    }
    controlWindow.setUpdateHandlers({
      getAppVersion: () => '0.9.1',
      getStatus: () => status,
      download: vi.fn(),
      install: vi.fn(),
      openReleaseNotes: vi.fn(),
    })

    expect(await ipcHandlers.get('control:update-status')!({ sender })).toEqual(
      status,
    )
  })

  it('reports idle before any updater is wired up', async () => {
    const controlWindow = new ControlWindow(configInfo)
    const sender = (controlWindow.win as unknown as FakeBrowserWindow)
      .webContents

    expect(await ipcHandlers.get('control:update-status')!({ sender })).toEqual(
      { state: 'idle' },
    )
  })

  it('installs the update when the renderer asks', async () => {
    const controlWindow = new ControlWindow(configInfo)
    const sender = (controlWindow.win as unknown as FakeBrowserWindow)
      .webContents
    const install = vi.fn()
    controlWindow.setUpdateHandlers({
      getAppVersion: () => '0.9.1',
      getStatus: () => ({ state: 'idle' }),
      download: vi.fn(),
      install,
      openReleaseNotes: vi.fn(),
    })

    await ipcHandlers.get('control:install-update')!({ sender })

    expect(install).toHaveBeenCalledOnce()
  })

  it('starts the update download when the renderer asks', async () => {
    const controlWindow = new ControlWindow(configInfo)
    const sender = (controlWindow.win as unknown as FakeBrowserWindow)
      .webContents
    const download = vi.fn()
    controlWindow.setUpdateHandlers({
      getAppVersion: () => '0.9.1',
      getStatus: () => ({ state: 'idle' }),
      download,
      install: vi.fn(),
      openReleaseNotes: vi.fn(),
    })

    await ipcHandlers.get('control:download-update')!({ sender })

    expect(download).toHaveBeenCalledOnce()
  })

  it('opens release notes without taking a URL from the renderer, so the target cannot be spoofed', async () => {
    const controlWindow = new ControlWindow(configInfo)
    const sender = (controlWindow.win as unknown as FakeBrowserWindow)
      .webContents
    const openReleaseNotes = vi.fn()
    controlWindow.setUpdateHandlers({
      getAppVersion: () => '0.9.1',
      getStatus: () => ({ state: 'idle' }),
      download: vi.fn(),
      install: vi.fn(),
      openReleaseNotes,
    })

    await ipcHandlers.get('control:open-release-notes')!(
      { sender },
      'https://evil.example/pwn',
    )

    expect(openReleaseNotes).toHaveBeenCalledOnce()
    expect(openReleaseNotes).toHaveBeenCalledWith()
  })

  it('ignores update IPC from a sender other than its own window', async () => {
    const controlWindow = new ControlWindow(configInfo)
    const install = vi.fn()
    const download = vi.fn()
    controlWindow.setUpdateHandlers({
      getAppVersion: () => '0.9.1',
      getStatus: () => ({ state: 'checking' }),
      download,
      install,
      openReleaseNotes: vi.fn(),
    })
    const foreignSender = { sender: { send: vi.fn() } }

    await ipcHandlers.get('control:install-update')!(foreignSender)
    await ipcHandlers.get('control:download-update')!(foreignSender)

    expect(install).not.toHaveBeenCalled()
    expect(download).not.toHaveBeenCalled()
    expect(
      await ipcHandlers.get('control:update-status')!(foreignSender),
    ).toBeUndefined()
  })
})

describe('ControlWindow app version', () => {
  it('reports the running version so the update banner can name what is being replaced', async () => {
    const controlWindow = new ControlWindow(configInfo)
    const sender = (controlWindow.win as unknown as FakeBrowserWindow)
      .webContents
    controlWindow.setUpdateHandlers({
      getAppVersion: () => '0.9.1',
      getStatus: () => ({ state: 'idle' }),
      download: vi.fn(),
      install: vi.fn(),
      openReleaseNotes: vi.fn(),
    })

    expect(await ipcHandlers.get('control:app-version')!({ sender })).toBe(
      '0.9.1',
    )
  })
})

// The control window holds the `streamwallControl` bridge, and every `control:*`
// sender guard compares against this very webContents -- so a navigation to a
// remote page would hand that page the whole bridge while still passing every
// check (#732).
describe('ControlWindow navigation hardening', () => {
  it('cancels a navigation to a remote page and opens it in the OS browser instead', () => {
    const controlWindow = new ControlWindow(configInfo)
    const { webContents } = controlWindow.win as unknown as FakeBrowserWindow

    expect(
      webContents.dispatchNavigation('will-navigate', 'https://evil.example/'),
    ).toBe(true)
    expect(openExternal).toHaveBeenCalledWith('https://evil.example/')
  })

  it("lets the window stay on the app's own page", () => {
    const controlWindow = new ControlWindow(configInfo)
    const { webContents } = controlWindow.win as unknown as FakeBrowserWindow

    expect(webContents.dispatchNavigation('will-navigate', APP_PAGE)).toBe(
      false,
    )
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('cancels a redirect escape too, so a 302 cannot do what a click cannot', () => {
    const controlWindow = new ControlWindow(configInfo)
    const { webContents } = controlWindow.win as unknown as FakeBrowserWindow

    expect(
      webContents.dispatchNavigation('will-redirect', 'https://evil.example/'),
    ).toBe(true)
  })

  it('denies renderer-opened windows and hands an http(s) link to the OS browser', () => {
    const controlWindow = new ControlWindow(configInfo)
    const { webContents } = controlWindow.win as unknown as FakeBrowserWindow

    expect(webContents.windowOpenHandler).not.toBeNull()
    expect(
      webContents.windowOpenHandler!({ url: 'https://example.com/stream' }),
    ).toEqual({ action: 'deny' })
    expect(openExternal).toHaveBeenCalledWith('https://example.com/stream')
  })

  it('does not hand a non-http scheme to the OS browser', () => {
    const controlWindow = new ControlWindow(configInfo)
    const { webContents } = controlWindow.win as unknown as FakeBrowserWindow

    expect(
      webContents.windowOpenHandler!({ url: 'file:///etc/passwd' }),
    ).toEqual({ action: 'deny' })
    expect(
      webContents.dispatchNavigation('will-navigate', 'file:///etc/passwd'),
    ).toBe(true)
    expect(openExternal).not.toHaveBeenCalled()
  })
})

describe('ControlWindow devtools', () => {
  it('opens the devtools for the renderer that owns the window', () => {
    const controlWindow = new ControlWindow(configInfo)
    const { webContents } = controlWindow.win as unknown as FakeBrowserWindow

    ipcHandlers.get('control:devtools')!({ sender: webContents })

    expect(webContents.openDevTools).toHaveBeenCalledOnce()
  })

  it('ignores requests from a sender other than its own window', () => {
    const controlWindow = new ControlWindow(configInfo)
    const { webContents } = controlWindow.win as unknown as FakeBrowserWindow

    ipcHandlers.get('control:devtools')!({ sender: { send: vi.fn() } })

    expect(webContents.openDevTools).not.toHaveBeenCalled()
  })
})

// Every `control:*` channel the window registers, together with the collaborator
// a successful invocation would reach. Adding a channel forces an author through
// this list, and the sweep below then demands a sender guard for it (#736).
const CONTROL_CHANNELS = [
  'control:load',
  'control:devtools',
  'control:command',
  'control:ydoc',
  'control:first-run-info',
  'control:open-config-folder',
  'control:create-example-config',
  'control:update-status',
  'control:app-version',
  'control:download-update',
  'control:install-update',
  'control:open-release-notes',
]

describe('ControlWindow sender guards', () => {
  it('registers exactly the known control channels', () => {
    new ControlWindow(configInfo)

    // Compared as a set: the registration order carries no meaning, and an
    // order-sensitive assertion would break on a behaviour-neutral reshuffle.
    expect(handle.mock.calls.map(([channel]) => channel).sort()).toEqual(
      [...CONTROL_CHANNELS].sort(),
    )
  })

  it('ignores every registered channel when the sender is not its own window', async () => {
    const controlWindow = new ControlWindow(configInfo)
    const { webContents } = controlWindow.win as unknown as FakeBrowserWindow
    const load = vi.fn()
    const ydoc = vi.fn()
    controlWindow.on('load', load)
    controlWindow.on('ydoc', ydoc)
    const commandHandler = vi.fn().mockResolvedValue({ error: 'nope' })
    controlWindow.setCommandHandler(commandHandler)
    const updateHandlers = {
      getAppVersion: vi.fn(() => '0.9.1'),
      getStatus: vi.fn(() => ({ state: 'idle' as const })),
      download: vi.fn(),
      install: vi.fn(),
      openReleaseNotes: vi.fn(),
    }
    controlWindow.setUpdateHandlers(updateHandlers)
    createExampleConfig.mockClear()
    openPath.mockClear()

    // Sweeps the pinned list rather than whatever happens to be registered, so
    // it cannot silently run over a shorter set than the pin test asserts.
    for (const channel of CONTROL_CHANNELS) {
      const handler = ipcHandlers.get(channel)
      expect(handler, `no handler registered for ${channel}`).toBeDefined()
      expect(await handler!({ sender: { send: vi.fn() } }, {})).toBeUndefined()
    }

    for (const spy of [
      load,
      ydoc,
      commandHandler,
      createExampleConfig,
      openPath,
      webContents.openDevTools,
      ...Object.values(updateHandlers),
    ]) {
      expect(spy).not.toHaveBeenCalled()
    }
  })
})
