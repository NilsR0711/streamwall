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
 * (`stop()`, `context.view`/`context.offscreenWin`/`context.disposeView`) to
 * verify a skipped view is torn down rather than leaked. `next`, when passed,
 * exercises the branch that also disposes an in-flight preload.
 */
function makeTeardownTrackingViewActor(
  id: number,
  next: { view: unknown; offscreenWin: unknown } | null = null,
) {
  const contentView = {}
  const offscreenWin = {}
  const disposeView = vi.fn()
  const stop = vi.fn()
  return {
    stop,
    disposeView,
    actor: {
      getSnapshot: () => ({
        context: {
          id,
          view: contentView,
          offscreenWin,
          pos: null,
          next,
          disposeView,
        },
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
    expect(tracked.disposeView).toHaveBeenCalledTimes(1)
    expect(sw.views.size).toBe(0)
  })

  it('also disposes an in-flight preload when tearing down a view that had one', () => {
    const sw = makeStreamWindow(makeConfig({ cols: 1, rows: 1 }))
    sw.win = {
      contentView: { removeChildView: vi.fn() },
    } as unknown as InstanceType<typeof StreamWindow>['win']
    sw.views = new Map()

    const next = { view: {}, offscreenWin: {} }
    const tracked = makeTeardownTrackingViewActor(99, next)
    sw.createView = vi.fn(() => tracked.actor)

    const viewContentMap: ViewContentMap = new Map([
      ['0', { url: 'https://example.com/missing', kind: 'video' }],
    ])
    const streams = { byURL: new Map() }

    sw.setViews(viewContentMap, streams)

    expect(tracked.disposeView).toHaveBeenCalledTimes(2)
    expect(tracked.disposeView).toHaveBeenCalledWith(
      next.view,
      next.offscreenWin,
    )
  })
})

/**
 * A minimal fake WebContentsView whose `webContents.on('did-fail-load', ...)`
 * registration is captured, so a test can trigger it directly instead of
 * needing a real Electron webContents.
 */
function makeFakeView(id: number) {
  const handlers: Record<string, (...args: never[]) => void> = {}
  const view = {
    webContents: {
      id,
      on: (event: string, cb: (...args: never[]) => void) => {
        handlers[event] = cb
      },
    },
  }
  return { view, handlers }
}

function fireDidFailLoad(
  handlers: Record<string, (...args: never[]) => void>,
  errorCode: number,
  isMainFrame: boolean,
) {
  handlers['did-fail-load']?.(
    ...([
      null,
      errorCode,
      'ERR_SOMETHING',
      'https://example.com',
      isMainFrame,
    ] as never[]),
  )
}

describe('StreamWindow view registration and disposal', () => {
  it('disposeRawView closes the webContents, destroys the offscreen window, and deregisters routing', () => {
    const sw = makeStreamWindow(makeConfig())
    const removeChildViewOnWin = vi.fn()
    sw.win = {
      contentView: { removeChildView: removeChildViewOnWin },
    } as unknown as InstanceType<typeof StreamWindow>['win']
    sw.viewsByWebContentsId = new Map([[7, {} as never]])
    const close = vi.fn()
    const view = { webContents: { id: 7, close } }
    const removeChildViewOnOffscreen = vi.fn()
    const destroy = vi.fn()
    const offscreenWin = {
      contentView: { removeChildView: removeChildViewOnOffscreen },
      destroy,
    }

    ;(
      sw as unknown as {
        disposeRawView: (v: unknown, w: unknown) => void
      }
    ).disposeRawView(view, offscreenWin)

    expect(removeChildViewOnOffscreen).toHaveBeenCalledWith(view)
    expect(removeChildViewOnWin).toHaveBeenCalledWith(view)
    expect(close).toHaveBeenCalledTimes(1)
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(sw.viewsByWebContentsId.has(7)).toBe(false)
  })

  function registerView(
    sw: InstanceType<typeof StreamWindow>,
    view: unknown,
    actor: unknown,
  ) {
    ;(
      sw as unknown as {
        registerView: (v: unknown, a: unknown) => void
      }
    ).registerView(view, actor)
  }

  it('routes a load failure on the currently displayed view to VIEW_ERROR', () => {
    const sw = makeStreamWindow(makeConfig())
    sw.viewsByWebContentsId = new Map()
    const { view, handlers } = makeFakeView(7)
    const send = vi.fn()
    const actor = {
      getSnapshot: () => ({ context: { view, next: null } }),
      send,
    }

    registerView(sw, view, actor)
    expect(sw.viewsByWebContentsId.get(7)).toBe(actor)
    fireDidFailLoad(handlers, -105, true)

    expect(send).toHaveBeenCalledWith({
      type: 'VIEW_ERROR',
      error: expect.any(Error),
    })
  })

  it('routes a load failure on the preloading next view to NEXT_VIEW_ERROR', () => {
    const sw = makeStreamWindow(makeConfig())
    sw.viewsByWebContentsId = new Map()
    const { view: currentView } = makeFakeView(7)
    const { view: nextView, handlers } = makeFakeView(8)
    const send = vi.fn()
    const actor = {
      getSnapshot: () => ({
        context: { view: currentView, next: { view: nextView } },
      }),
      send,
    }

    registerView(sw, nextView, actor)
    fireDidFailLoad(handlers, -105, true)

    expect(send).toHaveBeenCalledWith({
      type: 'NEXT_VIEW_ERROR',
      error: expect.any(Error),
    })
  })

  it('ignores a stale load failure from a view that is no longer current or next', () => {
    const sw = makeStreamWindow(makeConfig())
    sw.viewsByWebContentsId = new Map()
    const { view: currentView } = makeFakeView(7)
    const { view: staleView, handlers } = makeFakeView(9)
    const send = vi.fn()
    const actor = {
      getSnapshot: () => ({ context: { view: currentView, next: null } }),
      send,
    }

    // A view that was superseded (e.g. a completed swap, or an abandoned
    // preload) is never registered again for this actor, but its
    // webContents could still fire a straggling did-fail-load.
    registerView(sw, staleView, actor)
    fireDidFailLoad(handlers, -105, true)

    expect(send).not.toHaveBeenCalled()
  })

  it('ignores ERR_ABORTED and non-main-frame failures', () => {
    const sw = makeStreamWindow(makeConfig())
    sw.viewsByWebContentsId = new Map()
    const { view, handlers } = makeFakeView(7)
    const send = vi.fn()
    const actor = {
      getSnapshot: () => ({ context: { view, next: null } }),
      send,
    }

    registerView(sw, view, actor)
    fireDidFailLoad(handlers, -3, true) // ERR_ABORTED
    fireDidFailLoad(handlers, -105, false) // not the main frame

    expect(send).not.toHaveBeenCalled()
  })
})
