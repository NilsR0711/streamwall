import EventEmitter from 'events'
import { describe, expect, it, vi } from 'vitest'

// ControlWindow pulls in Electron directly and via ./loadHTML. Model
// BrowserWindow as a small EventEmitter so `win.on('close', ...)` wiring can
// be exercised the same way the real window would drive it, without an
// Electron runtime.
class FakeBrowserWindow extends EventEmitter {
  webContents = { send: vi.fn() }
  removeMenu = vi.fn()
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
})
