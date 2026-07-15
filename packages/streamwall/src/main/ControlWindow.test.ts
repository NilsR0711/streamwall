import EventEmitter from 'events'
import { describe, expect, it, vi } from 'vitest'

// ControlWindow pulls in Electron directly and via ./loadHTML. Model
// BrowserWindow as a small EventEmitter so `win.on('close', ...)` wiring can
// be exercised the same way the real window would drive it, without an
// Electron runtime.
class FakeBrowserWindow extends EventEmitter {
  webContents = { send: vi.fn() }
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

vi.mock('electron', () => ({
  BrowserWindow: FakeBrowserWindow,
  ipcMain: { handle },
  shell: { openPath },
}))

vi.mock('./loadHTML', () => ({ loadHTML: vi.fn() }))

const createExampleConfig = vi.fn()
vi.mock('./exampleConfig', () => ({ createExampleConfig }))

const { default: ControlWindow } = await import('./ControlWindow')

const configInfo = {
  configPath: '/home/test/.config/Streamwall/config.toml',
  hasUserConfig: false,
}

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
