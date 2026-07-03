import type { StreamWindowConfig } from 'streamwall-shared'
import { describe, expect, it, vi } from 'vitest'

// StreamWindow pulls in Electron (directly and via ./loadHTML and
// ./viewStateMachine). Stub the module so the file can be imported without an
// Electron runtime; setGridSize under test never touches these.
vi.mock('electron', () => ({
  BrowserWindow: class {},
  WebContentsView: class {},
  WebContents: class {},
  ipcMain: { handle: () => {}, on: () => {} },
  app: {},
}))

const { default: StreamWindow } = await import('./StreamWindow')

function makeConfig(
  overrides: Partial<StreamWindowConfig> = {},
): StreamWindowConfig {
  return {
    cols: 3,
    rows: 3,
    width: 1920,
    height: 1080,
    frameless: false,
    activeColor: '#fff',
    backgroundColor: '#000',
    ...overrides,
  }
}

/**
 * Builds a StreamWindow instance without running the constructor (which would
 * create real Electron windows), so `setGridSize` can be exercised in
 * isolation against a plain config object.
 */
function makeStreamWindow(config: StreamWindowConfig) {
  const sw = Object.create(StreamWindow.prototype) as InstanceType<
    typeof StreamWindow
  >
  sw.config = config
  return sw
}

describe('StreamWindow.setGridSize', () => {
  it('updates the grid dimensions', () => {
    const config = makeConfig()
    const sw = makeStreamWindow(config)

    sw.setGridSize(5, 4)

    expect(sw.config.cols).toBe(5)
    expect(sw.config.rows).toBe(4)
  })

  it('mutates the shared config object in place instead of replacing it', () => {
    const config = makeConfig()
    const sw = makeStreamWindow(config)

    sw.setGridSize(5, 4)

    // The config reference must be preserved: the main process shares one
    // config object across streamWindow.config, clientState.config and the
    // resize pipeline. Replacing it detaches those references and desyncs the
    // overlay/control grid from the wall on the next resize (issue #14).
    expect(sw.config).toBe(config)
    expect(config.cols).toBe(5)
    expect(config.rows).toBe(4)
  })

  it('leaves the window dimensions untouched', () => {
    const config = makeConfig({ width: 2560, height: 1440 })
    const sw = makeStreamWindow(config)

    sw.setGridSize(2, 6)

    expect(config.width).toBe(2560)
    expect(config.height).toBe(1440)
  })
})
