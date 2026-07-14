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

vi.mock('electron', () => ({
  BrowserWindow: FakeBrowserWindow,
  ipcMain: { handle: vi.fn() },
}))

vi.mock('./loadHTML', () => ({ loadHTML: vi.fn() }))

const { default: ControlWindow } = await import('./ControlWindow')

describe('ControlWindow close', () => {
  it('forwards the underlying Electron close event so callers can preventDefault', () => {
    const controlWindow = new ControlWindow()
    const closeListener = vi.fn()
    controlWindow.on('close', closeListener)

    const fakeEvent = { preventDefault: vi.fn() }
    controlWindow.win.emit('close', fakeEvent)

    expect(closeListener).toHaveBeenCalledWith(fakeEvent)
  })

  it('keeps the native close control enabled so the quit/hide behavior wired through the close event is reachable from the window chrome', () => {
    const controlWindow = new ControlWindow()

    expect(
      (controlWindow.win as unknown as FakeBrowserWindow).options.closable,
    ).not.toBe(false)
  })
})
