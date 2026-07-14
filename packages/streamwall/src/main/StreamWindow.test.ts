import type { StreamWindowConfig, ViewContentMap } from 'streamwall-shared'
import { describe, expect, it, vi } from 'vitest'

// StreamWindow pulls in Electron (directly and via ./loadHTML and
// ./viewStateMachine). Stub the module so the file can be imported without an
// Electron runtime; setGridSize under test never touches these.
vi.mock('electron', () => ({
  BrowserWindow: class {},
  WebContentsView: class {},
  WebContents: class {},
  ipcMain: { handle: () => {}, on: () => {} },
  screen: { getAllDisplays: () => [] },
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
    fullscreen: false,
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

/**
 * A minimal stand-in for a ViewActor: enough of the `getSnapshot()`/`send()`
 * surface for setViewVolume/sendViewEvent/findViewByIdx to operate on,
 * without a real XState actor or Electron WebContentsView.
 */
function makeFakeViewActor(pos: { spaces: number[] } | null, send = vi.fn()) {
  return {
    getSnapshot: () => ({ context: { pos } }),
    send,
  } as unknown as ReturnType<typeof StreamWindow.prototype.createView>
}

describe('StreamWindow.setViewVolume', () => {
  it('sends SET_VOLUME to the view occupying the given index', () => {
    const sw = makeStreamWindow(makeConfig())
    const send = vi.fn()
    sw.views = new Map([[1, makeFakeViewActor({ spaces: [0] }, send)]])

    sw.setViewVolume(0, 0.5)

    expect(send).toHaveBeenCalledWith({ type: 'SET_VOLUME', volume: 0.5 })
  })

  it('does nothing when no view occupies the given index', () => {
    const sw = makeStreamWindow(makeConfig())
    const send = vi.fn()
    sw.views = new Map([[1, makeFakeViewActor({ spaces: [0] }, send)]])

    sw.setViewVolume(5, 0.5)

    expect(send).not.toHaveBeenCalled()
  })
})

describe('StreamWindow.emitState', () => {
  it('includes each view volume in the emitted state', () => {
    const sw = makeStreamWindow(makeConfig())
    sw.views = new Map([
      [
        1,
        makeFakeViewActorWithSnapshot({
          value: 'empty',
          context: {
            id: 1,
            content: null,
            info: null,
            pos: null,
            error: null,
            volume: 0.6,
          },
        }),
      ],
    ])
    const emitted: unknown[] = []
    sw.on('state', (states) => emitted.push(states))

    sw.emitState()

    expect(emitted).toEqual([
      [
        {
          state: 'empty',
          context: expect.objectContaining({ volume: 0.6 }),
        },
      ],
    ])
  })
})

function makeFakeViewActorWithSnapshot(snapshot: {
  value: unknown
  context: Record<string, unknown>
}) {
  return {
    getSnapshot: () => snapshot,
    send: vi.fn(),
  } as unknown as ReturnType<typeof StreamWindow.prototype.createView>
}

/**
 * A stand-in for a ViewActor with enough of the `setViews()` teardown surface
 * (`stop()`, `context.view`/`context.offscreenWin`) to verify a skipped view
 * is torn down rather than leaked.
 */
function makeTeardownTrackingViewActor(id: number) {
  const contentView = { webContents: { close: vi.fn() } }
  const offscreenWin = {
    contentView: { removeChildView: vi.fn() },
    destroy: vi.fn(),
  }
  const stop = vi.fn()
  return {
    stop,
    contentView,
    offscreenWin,
    actor: {
      getSnapshot: () => ({
        context: { id, view: contentView, offscreenWin, pos: null },
        matches: () => false,
      }),
      matches: () => false,
      send: vi.fn(),
      stop,
    } as unknown as ReturnType<typeof StreamWindow.prototype.createView>,
  }
}

describe('StreamWindow.setViews', () => {
  it('tears down a newly created view whose box content has no matching stream, instead of leaking it', () => {
    const sw = makeStreamWindow(makeConfig({ cols: 1, rows: 1 }))
    sw.win = {
      contentView: { removeChildView: vi.fn() },
    } as unknown as InstanceType<typeof StreamWindow>['win']
    sw.views = new Map()

    const tracked = makeTeardownTrackingViewActor(99)
    sw.createView = vi.fn(() => tracked.actor)

    // A box exists for space 0, but the URL it references is not present in
    // `streams.byURL`, exercising the `!stream` skip branch in setViews.
    const viewContentMap: ViewContentMap = new Map([
      ['0', { url: 'https://example.com/missing', kind: 'video' }],
    ])
    const streams = { byURL: new Map() }

    sw.setViews(viewContentMap, streams)

    expect(tracked.stop).toHaveBeenCalled()
    expect(tracked.contentView.webContents.close).toHaveBeenCalled()
    expect(tracked.offscreenWin.destroy).toHaveBeenCalled()
    expect(sw.views.size).toBe(0)
  })
})
