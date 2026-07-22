import {
  asCellIdx,
  fullscreenViewContentMap,
  type StreamWindowConfig,
  type ViewContent,
  type ViewContentMap,
} from 'streamwall-shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Instances created by the Electron stub below, in creation order, so the
 * constructor test can assert *what* was built and *in which order* without a
 * real Electron runtime.
 */
const electronStub = vi.hoisted(() => ({
  windows: [] as Array<InstanceType<typeof import('electron').BrowserWindow>>,
  webContentsViews: [] as Array<
    InstanceType<typeof import('electron').WebContentsView>
  >,
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}))

// StreamWindow pulls in Electron (directly and via ./loadHTML and
// ./viewStateMachine). Stub the module so the file can be imported without an
// Electron runtime. Most tests here build their own plain-object doubles and
// never touch these classes; the constructor test does, so the stubs carry
// just enough of the BrowserWindow / WebContentsView surface the constructor
// exercises.
vi.mock('electron', () => {
  let nextWebContentsId = 1
  class BrowserWindow {
    options: Record<string, unknown>
    removeMenu = vi.fn()
    loadURL = vi.fn()
    on = vi.fn()
    once = vi.fn()
    destroy = vi.fn()
    getContentSize = vi.fn(() => [0, 0])
    getBounds = vi.fn(() => ({ x: 0, y: 0, width: 0, height: 0 }))
    contentView = { addChildView: vi.fn(), removeChildView: vi.fn() }
    constructor(options: Record<string, unknown> = {}) {
      this.options = options
      electronStub.windows.push(this as never)
    }
  }
  class WebContentsView {
    options: Record<string, unknown>
    webContents = {
      id: nextWebContentsId++,
      on: vi.fn(),
      send: vi.fn(),
      close: vi.fn(),
      openDevTools: vi.fn(),
      session: {},
    }
    setBackgroundColor = vi.fn()
    setBounds = vi.fn()
    constructor(options: Record<string, unknown> = {}) {
      this.options = options
      electronStub.webContentsViews.push(this as never)
    }
  }
  return {
    BrowserWindow,
    WebContentsView,
    WebContents: class {},
    ipcMain: electronStub.ipcMain,
    screen: { getAllDisplays: () => [] },
    app: {},
  }
})

// `loadHTML` reads the MAIN_WINDOW_VITE_* globals that only exist in a Vite
// build, and would resolve renderer HTML off disk. The constructor test only
// cares about which page each layer is told to load, so record the calls.
vi.mock('./loadHTML', () => ({
  loadHTML: vi.fn(),
  devServerOrigin: () => undefined,
}))

const { default: StreamWindow } = await import('./StreamWindow')
const { loadHTML } = await import('./loadHTML')

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
  sw.parkedViews = new Map()
  sw.pauseParkedViews = false
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
 * surface for setViewVolume/sendViewEvent/findViewById to operate on,
 * without a real XState actor or Electron WebContentsView.
 */
function makeFakeViewActor(pos: { spaces: number[] } | null, send = vi.fn()) {
  return {
    getSnapshot: () => ({ context: { pos } }),
    send,
  } as unknown as ReturnType<typeof StreamWindow.prototype.createView>
}

describe('StreamWindow.setViewVolume', () => {
  it('sends SET_VOLUME to the view with the given stable id', () => {
    const sw = makeStreamWindow(makeConfig())
    const send = vi.fn()
    sw.views = new Map([[1, makeFakeViewActor({ spaces: [0] }, send)]])

    sw.setViewVolume(1, 0.5)

    expect(send).toHaveBeenCalledWith({ type: 'SET_VOLUME', volume: 0.5 })
  })

  it('does nothing when no view has the given id', () => {
    const sw = makeStreamWindow(makeConfig())
    const send = vi.fn()
    sw.views = new Map([[1, makeFakeViewActor({ spaces: [0] }, send)]])

    sw.setViewVolume(5, 0.5)

    expect(send).not.toHaveBeenCalled()
  })

  it('reaches the view by id even after a resize moved it to a new cell (issue #397)', () => {
    // The view keeps stable id 42 but now occupies cell 7 instead of 0. A
    // command addressed by its id must still reach it, and must not leak onto
    // whatever view now sits at the view's old cell.
    const sw = makeStreamWindow(makeConfig())
    const movedSend = vi.fn()
    const otherSend = vi.fn()
    sw.views = new Map([
      [42, makeFakeViewActor({ spaces: [7] }, movedSend)],
      [9, makeFakeViewActor({ spaces: [0] }, otherSend)],
    ])

    sw.setViewVolume(42, 0.25)

    expect(movedSend).toHaveBeenCalledWith({ type: 'SET_VOLUME', volume: 0.25 })
    expect(otherSend).not.toHaveBeenCalled()
  })
})

describe('StreamWindow.setListeningView', () => {
  function displayingActor(send = vi.fn()) {
    return {
      getSnapshot: () => ({
        matches: (query: unknown) => query === 'displaying',
      }),
      send,
    } as unknown as ReturnType<typeof StreamWindow.prototype.createView>
  }

  it('unmutes the view with the given id and mutes the rest, by stable id (issue #397)', () => {
    const sw = makeStreamWindow(makeConfig())
    const selected = vi.fn()
    const other = vi.fn()
    sw.views = new Map([
      [42, displayingActor(selected)],
      [9, displayingActor(other)],
    ])

    sw.setListeningView(42)

    expect(selected).toHaveBeenCalledWith({ type: 'UNMUTE' })
    expect(other).toHaveBeenCalledWith({ type: 'MUTE' })
  })

  it('mutes every view when the listening id is null', () => {
    const sw = makeStreamWindow(makeConfig())
    const a = vi.fn()
    const b = vi.fn()
    sw.views = new Map([
      [1, displayingActor(a)],
      [2, displayingActor(b)],
    ])

    sw.setListeningView(null)

    expect(a).toHaveBeenCalledWith({ type: 'MUTE' })
    expect(b).toHaveBeenCalledWith({ type: 'MUTE' })
  })
})

describe('StreamWindow.getViewAnchorIdx', () => {
  it('returns the top-left cell of the view with the given id', () => {
    const sw = makeStreamWindow(makeConfig())
    sw.views = new Map([[42, makeFakeViewActor({ spaces: [7, 8] })]])

    expect(sw.getViewAnchorIdx(42)).toBe(7)
  })

  it('returns null for an unknown id or a view without a placement', () => {
    const sw = makeStreamWindow(makeConfig())
    sw.views = new Map([[42, makeFakeViewActor(null)]])

    expect(sw.getViewAnchorIdx(42)).toBeNull()
    expect(sw.getViewAnchorIdx(999)).toBeNull()
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

  it('replaces this.views only after the teardown pass, so a state event emitted mid-teardown still describes the old layout', () => {
    const sw = makeStreamWindow(makeConfig({ cols: 1, rows: 1 }))
    sw.win = {
      contentView: { removeChildView: vi.fn() },
    } as unknown as InstanceType<typeof StreamWindow>['win']

    const streamA: ViewContent = { url: 'https://example.com/a', kind: 'video' }
    const orphan = makeReuseTestActor({
      id: 1,
      content: streamA,
      spaces: [0],
      running: true,
    })
    sw.views = new Map([[1, orphan.actor]])
    sw.createView = vi.fn()

    const emitted: number[][] = []
    sw.on('state', (states) =>
      emitted.push(states.map((s) => s.context.id as number)),
    )
    // A real actor's `stop()` pushes a final snapshot to the subscription
    // `createView()` installs, which calls `emitState()` synchronously -- so
    // the teardown pass observes whatever `this.views` holds at that moment.
    orphan.stop.mockImplementation(() => {
      sw.emitState()
    })

    // The single box is dropped, leaving the actor unused: it is stopped, and
    // that stop emits state while `setViews` is still mid-flight.
    sw.setViews(new Map(), { byURL: new Map() })

    expect(orphan.stop).toHaveBeenCalled()
    // The intermediate emit must still describe the pre-teardown layout.
    // Assigning `this.views = newViews` before `retireUnusedViews` would make
    // this emit the (already empty) new layout instead, publishing a layout
    // the wall has not been torn down to yet.
    expect(emitted[0]).toEqual([1])
    // ...and the final emit, after the swap, describes the new layout.
    expect(emitted.at(-1)).toEqual([])
    expect(sw.views.size).toBe(0)
  })
})

/** Typed access to the private halves of `setViews`' plan executor. */
function planExecutorOf(sw: InstanceType<typeof StreamWindow>) {
  return sw as unknown as {
    displayPlannedViews: (
      viewsToDisplay: Array<{ box: unknown; view: unknown }>,
      streams: unknown,
      previouslyParkedIds: Set<unknown>,
      unusedViews: Set<unknown>,
    ) => Map<number, unknown>
    retireUnusedViews: (unusedViews: Set<unknown>, parkUnused: boolean) => void
  }
}

describe('StreamWindow.displayPlannedViews', () => {
  it('hands a planned view whose box carries no content to the teardown pass instead of dropping it', () => {
    // The sibling of the `!stream` case pinned above. It is exercised through
    // the private method rather than through `setViews`, because
    // `boxesFromViewContentMap` skips empty cells and so never emits a
    // content-less box today -- the branch is defensive, and dropping the
    // actor there would leak it, its WebContentsView and its offscreen
    // BrowserWindow permanently.
    const sw = makeStreamWindow(makeConfig({ cols: 1, rows: 1 }))
    sw.win = {
      contentView: { removeChildView: vi.fn() },
    } as unknown as InstanceType<typeof StreamWindow>['win']

    const tracked = makeTeardownTrackingViewActor(99)
    const box = {
      content: undefined,
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      spaces: [asCellIdx(0)],
    }
    const unusedViews = new Set<unknown>()

    const newViews = planExecutorOf(sw).displayPlannedViews(
      [{ box, view: tracked.actor }],
      { byURL: new Map() },
      new Set(),
      unusedViews,
    )

    // The actor is not placed...
    expect(newViews.size).toBe(0)
    // ...but it is handed over for reclamation rather than silently forgotten.
    expect(unusedViews.has(tracked.actor)).toBe(true)

    planExecutorOf(sw).retireUnusedViews(unusedViews, false)

    expect(tracked.stop).toHaveBeenCalled()
    expect(tracked.disposeView).toHaveBeenCalledTimes(1)
  })
})

/**
 * A stand-in for a ViewActor whose `getSnapshot().matches({ displaying:
 * 'running' })` responds according to `running`, for exercising setViews'
 * space-overlap-only matcher (issue #311): it must only reuse an actor that
 * is actually in the `running` state, since neither `loading` nor `error`
 * have a DISPLAY handler of their own for changed content -- the event would
 * bubble to `displaying`'s handler, whose `contentUnchanged` guard would then
 * silently swallow it, stranding the actor on its old content forever.
 */
function makeReuseTestActor(opts: {
  id: number
  content: ViewContent | null
  spaces: number[]
  running: boolean
}) {
  const send = vi.fn()
  const stop = vi.fn()
  const disposeView = vi.fn()
  const setBounds = vi.fn()
  const removeChildViewOnWin = vi.fn()
  const addChildViewOnOffscreen = vi.fn()
  const view = { setBounds }
  const win = { contentView: { removeChildView: removeChildViewOnWin } }
  const offscreenWin = {
    contentView: { addChildView: addChildViewOnOffscreen },
    getBounds: () => ({ width: 100, height: 100 }),
  }
  const actor = {
    getSnapshot: () => ({
      context: {
        id: opts.id,
        content: opts.content,
        pos: { spaces: opts.spaces },
        view,
        win,
        offscreenWin,
        next: null,
        disposeView,
      },
      matches: (query: { displaying: string }) =>
        opts.running && query.displaying === 'running',
    }),
    send,
    stop,
  } as unknown as ReturnType<typeof StreamWindow.prototype.createView>
  return {
    actor,
    send,
    stop,
    disposeView,
    setBounds,
    removeChildViewOnWin,
    addChildViewOnOffscreen,
  }
}

describe('StreamWindow.setViews reusing an actor across a genuine content change', () => {
  it('sends DISPLAY to the running actor already occupying a box space instead of tearing it down and creating a new view (issue #311)', () => {
    const sw = makeStreamWindow(makeConfig({ cols: 1, rows: 1 }))
    sw.win = {
      contentView: { removeChildView: vi.fn() },
    } as unknown as InstanceType<typeof StreamWindow>['win']

    const streamA: ViewContent = {
      url: 'https://example.com/a',
      kind: 'video',
    }
    const streamB: ViewContent = {
      url: 'https://example.com/b',
      kind: 'video',
    }
    const { actor, send, stop } = makeReuseTestActor({
      id: 1,
      content: streamA,
      spaces: [0],
      running: true,
    })
    sw.views = new Map([[1, actor]])
    sw.createView = vi.fn()

    // Space 0 now requests streamB instead of the streamA the actor there is
    // currently displaying -- a genuine content change, e.g. a playlist
    // advance or a drag-to-place reassignment.
    const viewContentMap: ViewContentMap = new Map([['0', streamB]])
    const streams = { byURL: new Map([[streamB.url, {}]]) }

    sw.setViews(viewContentMap, streams)

    expect(sw.createView).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'DISPLAY', content: streamB }),
    )
    expect(sw.views.get(1)).toBe(actor)
  })

  it('does not reuse a still-loading actor across a content change, since the state machine has no handler that would apply it', () => {
    const sw = makeStreamWindow(makeConfig({ cols: 1, rows: 1 }))
    sw.win = {
      contentView: { removeChildView: vi.fn() },
    } as unknown as InstanceType<typeof StreamWindow>['win']

    const streamA: ViewContent = {
      url: 'https://example.com/a',
      kind: 'video',
    }
    const streamB: ViewContent = {
      url: 'https://example.com/b',
      kind: 'video',
    }
    const { actor, send, stop, disposeView } = makeReuseTestActor({
      id: 1,
      content: streamA,
      spaces: [0],
      running: false,
    })
    sw.views = new Map([[1, actor]])
    const { actor: newActor, send: newSend } = makeReuseTestActor({
      id: 2,
      content: null,
      spaces: [],
      running: false,
    })
    sw.createView = vi.fn(() => newActor)

    const viewContentMap: ViewContentMap = new Map([['0', streamB]])
    const streams = { byURL: new Map([[streamB.url, {}]]) }

    sw.setViews(viewContentMap, streams)

    expect(sw.createView).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalled()
    expect(disposeView).toHaveBeenCalled()
    expect(newSend).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'DISPLAY', content: streamB }),
    )
  })

  it('still prefers an exact same-content match over the space-overlap fallback when both apply to different boxes', () => {
    const sw = makeStreamWindow(makeConfig({ cols: 3, rows: 1 }))
    sw.win = {
      contentView: { removeChildView: vi.fn() },
    } as unknown as InstanceType<typeof StreamWindow>['win']

    const streamA: ViewContent = {
      url: 'https://example.com/a',
      kind: 'video',
    }
    const streamB: ViewContent = {
      url: 'https://example.com/b',
      kind: 'video',
    }
    const streamC: ViewContent = {
      url: 'https://example.com/c',
      kind: 'video',
    }
    const streamE: ViewContent = {
      url: 'https://example.com/e',
      kind: 'video',
    }
    // Occupies space 0, showing stale content A that nothing wants anymore --
    // a candidate for the space-overlap fallback once space 0 asks for
    // something new.
    const spaceOnly = makeReuseTestActor({
      id: 1,
      content: streamA,
      spaces: [0],
      running: true,
    })
    // Occupies space 1, but its content B is requested by a different box
    // (space 2) -- a candidate for the exact-content matcher, which must
    // claim it (and reposition it there) before the fallback matcher ever
    // runs, regardless of which space it currently sits in.
    const moved = makeReuseTestActor({
      id: 2,
      content: streamB,
      spaces: [1],
      running: true,
    })
    sw.views = new Map([
      [1, spaceOnly.actor],
      [2, moved.actor],
    ])
    const { actor: newActor, send: newSend } = makeReuseTestActor({
      id: 3,
      content: null,
      spaces: [],
      running: false,
    })
    sw.createView = vi.fn(() => newActor)

    const viewContentMap: ViewContentMap = new Map([
      ['0', streamC], // genuine content change -> should reuse spaceOnly
      ['1', streamE], // unrelated new content -> no existing actor fits
      ['2', streamB], // same content as `moved`, elsewhere -> should reuse moved
    ])
    const streams = {
      byURL: new Map([
        [streamB.url, {}],
        [streamC.url, {}],
        [streamE.url, {}],
      ]),
    }

    sw.setViews(viewContentMap, streams)

    // Only the unrelated box (space 1) needed a brand-new view.
    expect(sw.createView).toHaveBeenCalledTimes(1)
    expect(newSend).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'DISPLAY', content: streamE }),
    )

    // The exact-content match reused `moved` for its new space instead of
    // being pre-empted by the space-overlap fallback.
    expect(moved.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'DISPLAY', content: streamB }),
    )
    expect(moved.stop).not.toHaveBeenCalled()

    // The space-overlap fallback reused `spaceOnly` for its box's genuinely
    // new content instead of tearing it down.
    expect(spaceOnly.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'DISPLAY', content: streamC }),
    )
    expect(spaceOnly.stop).not.toHaveBeenCalled()
  })
})

describe('StreamWindow.setViews matcher precedence', () => {
  const streamA: ViewContent = { url: 'https://example.com/a', kind: 'video' }

  it('prefers the same-content view already sitting in the box space over an equally-matching one elsewhere', () => {
    const sw = makeStreamWindow(makeConfig({ cols: 2, rows: 1 }))
    sw.win = {
      contentView: { removeChildView: vi.fn() },
    } as unknown as InstanceType<typeof StreamWindow>['win']

    const inPlace = makeReuseTestActor({
      id: 1,
      content: streamA,
      spaces: [0],
      running: true,
    })
    const elsewhere = makeReuseTestActor({
      id: 2,
      content: streamA,
      spaces: [1],
      running: true,
    })
    // `elsewhere` is registered first, so only the space-overlap tie-break in
    // the first matcher can make `inPlace` win.
    sw.views = new Map([
      [2, elsewhere.actor],
      [1, inPlace.actor],
    ])
    sw.createView = vi.fn()

    sw.setViews(new Map([['0', streamA]]), {
      byURL: new Map([[streamA.url, {}]]),
    })

    expect(sw.createView).not.toHaveBeenCalled()
    expect(inPlace.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'DISPLAY', content: streamA }),
    )
    expect(sw.views.get(1)).toBe(inPlace.actor)
    // The redundant copy is torn down rather than left dangling.
    expect(elsewhere.stop).toHaveBeenCalled()
    expect(sw.views.has(2)).toBe(false)
  })

  it('reuses a still-loading view that already has the requested content instead of creating a new one', () => {
    const sw = makeStreamWindow(makeConfig({ cols: 1, rows: 1 }))
    sw.win = {
      contentView: { removeChildView: vi.fn() },
    } as unknown as InstanceType<typeof StreamWindow>['win']

    const loading = makeReuseTestActor({
      id: 1,
      content: streamA,
      spaces: [0],
      running: false,
    })
    sw.views = new Map([[1, loading.actor]])
    sw.createView = vi.fn()

    sw.setViews(new Map([['0', streamA]]), {
      byURL: new Map([[streamA.url, {}]]),
    })

    expect(sw.createView).not.toHaveBeenCalled()
    expect(loading.stop).not.toHaveBeenCalled()
    expect(loading.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'DISPLAY', content: streamA }),
    )
    expect(sw.views.get(1)).toBe(loading.actor)
  })

  it('prefers a live view over an equally-matching parked one', () => {
    const sw = makeStreamWindow(makeConfig({ cols: 1, rows: 1 }))
    sw.win = {
      contentView: { removeChildView: vi.fn() },
    } as unknown as InstanceType<typeof StreamWindow>['win']

    const live = makeReuseTestActor({
      id: 1,
      content: streamA,
      spaces: [0],
      running: true,
    })
    const parked = makeReuseTestActor({
      id: 2,
      content: streamA,
      spaces: [0],
      running: true,
    })
    sw.views = new Map([[1, live.actor]])
    sw.parkedViews = new Map([[2, parked.actor]])
    sw.createView = vi.fn()

    sw.setViews(new Map([['0', streamA]]), {
      byURL: new Map([[streamA.url, {}]]),
    })

    expect(sw.views.get(1)).toBe(live.actor)
    expect(live.stop).not.toHaveBeenCalled()
    expect(parked.stop).toHaveBeenCalled()
    // The parking bookkeeping is reset by every setViews call.
    expect(sw.parkedViews.size).toBe(0)
  })

  it('tears down a view that no box wants and that is not parked', () => {
    const sw = makeStreamWindow(makeConfig({ cols: 1, rows: 1 }))
    sw.win = {
      contentView: { removeChildView: vi.fn() },
    } as unknown as InstanceType<typeof StreamWindow>['win']

    const orphan = makeReuseTestActor({
      id: 1,
      content: streamA,
      spaces: [0],
      running: true,
    })
    sw.views = new Map([[1, orphan.actor]])
    sw.createView = vi.fn()

    sw.setViews(new Map(), { byURL: new Map() })

    expect(orphan.stop).toHaveBeenCalled()
    expect(orphan.disposeView).toHaveBeenCalledTimes(1)
    expect(sw.views.size).toBe(0)
  })
})

describe('StreamWindow.setViews expanding a view to fill the wall (issue #362)', () => {
  it('reuses the running actor and spans it across every grid cell', () => {
    const sw = makeStreamWindow(makeConfig({ cols: 2, rows: 2 }))
    sw.win = {
      contentView: { removeChildView: vi.fn() },
    } as unknown as InstanceType<typeof StreamWindow>['win']

    const streamA: ViewContent = {
      url: 'https://example.com/a',
      kind: 'video',
    }
    const streamB: ViewContent = {
      url: 'https://example.com/b',
      kind: 'video',
    }
    // streamB is currently running in a single cell (index 1) of the 2x2 wall;
    // streamA occupies another cell and must be torn down when B expands.
    const expanding = makeReuseTestActor({
      id: 1,
      content: streamB,
      spaces: [1],
      running: true,
    })
    const other = makeReuseTestActor({
      id: 2,
      content: streamA,
      spaces: [0],
      running: true,
    })
    sw.views = new Map([
      [1, expanding.actor],
      [2, other.actor],
    ])
    sw.createView = vi.fn()

    // The fullscreen override fills every cell with streamB.
    sw.setViews(fullscreenViewContentMap(2, 2, streamB), {
      byURL: new Map([[streamB.url, {}]]),
    })

    // No new view is created: the already-running streamB actor is reused and
    // repositioned to span the whole wall.
    expect(sw.createView).not.toHaveBeenCalled()
    expect(expanding.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'DISPLAY',
        content: streamB,
        pos: expect.objectContaining({ spaces: [0, 1, 2, 3] }),
      }),
    )
    // The other stream is torn down (its cell is now hidden behind the
    // expanded view).
    expect(other.stop).toHaveBeenCalled()
    expect(sw.views.size).toBe(1)
    expect(sw.views.get(1)).toBe(expanding.actor)
  })
})

describe('StreamWindow.setViews parking unused views during a fullscreen expansion (issue #369)', () => {
  it('hides a non-focused running view instead of tearing it down when parkUnused is requested', () => {
    const sw = makeStreamWindow(makeConfig({ cols: 2, rows: 2 }))
    sw.win = {
      contentView: { removeChildView: vi.fn() },
    } as unknown as InstanceType<typeof StreamWindow>['win']

    const streamA: ViewContent = {
      url: 'https://example.com/a',
      kind: 'video',
    }
    const streamB: ViewContent = {
      url: 'https://example.com/b',
      kind: 'video',
    }
    const expanding = makeReuseTestActor({
      id: 1,
      content: streamB,
      spaces: [1],
      running: true,
    })
    const other = makeReuseTestActor({
      id: 2,
      content: streamA,
      spaces: [0],
      running: true,
    })
    sw.views = new Map([
      [1, expanding.actor],
      [2, other.actor],
    ])
    sw.createView = vi.fn()

    sw.setViews(
      fullscreenViewContentMap(2, 2, streamB),
      { byURL: new Map([[streamB.url, {}]]) },
      { parkUnused: true },
    )

    // The non-focused actor survives instead of being stopped/disposed...
    expect(other.stop).not.toHaveBeenCalled()
    expect(other.disposeView).not.toHaveBeenCalled()
    // ...but is moved off the visible wall onto its own offscreen host so it
    // does not render on top of (or behind) the expanded view.
    expect(other.removeChildViewOnWin).toHaveBeenCalled()
    expect(other.addChildViewOnOffscreen).toHaveBeenCalled()
    // It no longer appears in the emitted view states (only the expanded
    // view is visible, matching the pre-#369 behavior)...
    expect(sw.views.size).toBe(1)
    expect(sw.views.get(1)).toBe(expanding.actor)
    // ...but StreamWindow retains it internally so a later collapse can
    // reuse it instead of recreating it from scratch.
    expect(
      (sw as unknown as { parkedViews: Map<number, unknown> }).parkedViews.get(
        2,
      ),
    ).toBe(other.actor)
  })

  it('reuses a parked view instead of creating a new one when the fullscreen view collapses', () => {
    const sw = makeStreamWindow(makeConfig({ cols: 2, rows: 2 }))
    sw.win = {
      contentView: { removeChildView: vi.fn() },
    } as unknown as InstanceType<typeof StreamWindow>['win']

    const streamA: ViewContent = {
      url: 'https://example.com/a',
      kind: 'video',
    }
    const streamB: ViewContent = {
      url: 'https://example.com/b',
      kind: 'video',
    }
    const expanding = makeReuseTestActor({
      id: 1,
      content: streamB,
      spaces: [1],
      running: true,
    })
    const other = makeReuseTestActor({
      id: 2,
      content: streamA,
      spaces: [0],
      running: true,
    })
    sw.views = new Map([
      [1, expanding.actor],
      [2, other.actor],
    ])
    sw.createView = vi.fn()

    // Expand: `other` is parked instead of disposed.
    sw.setViews(
      fullscreenViewContentMap(2, 2, streamB),
      { byURL: new Map([[streamB.url, {}]]) },
      { parkUnused: true },
    )

    // Collapse: the normal per-cell layout is restored.
    const viewContentMap: ViewContentMap = new Map([
      ['0', streamA],
      ['1', streamB],
    ])
    sw.setViews(viewContentMap, {
      byURL: new Map([
        [streamA.url, {}],
        [streamB.url, {}],
      ]),
    })

    // The parked actor is reused for its original space instead of a new
    // view being created for it (which would show a reload/black flash).
    expect(sw.createView).not.toHaveBeenCalled()
    expect(other.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'DISPLAY', content: streamA }),
    )
    expect(sw.views.size).toBe(2)
    expect(sw.views.get(2)).toBe(other.actor)
  })

  it('still tears down a view left unused after collapse (its cell was cleared while expanded)', () => {
    const sw = makeStreamWindow(makeConfig({ cols: 2, rows: 2 }))
    sw.win = {
      contentView: { removeChildView: vi.fn() },
    } as unknown as InstanceType<typeof StreamWindow>['win']

    const streamA: ViewContent = {
      url: 'https://example.com/a',
      kind: 'video',
    }
    const streamB: ViewContent = {
      url: 'https://example.com/b',
      kind: 'video',
    }
    const expanding = makeReuseTestActor({
      id: 1,
      content: streamB,
      spaces: [1],
      running: true,
    })
    const other = makeReuseTestActor({
      id: 2,
      content: streamA,
      spaces: [0],
      running: true,
    })
    sw.views = new Map([
      [1, expanding.actor],
      [2, other.actor],
    ])
    sw.createView = vi.fn()

    sw.setViews(
      fullscreenViewContentMap(2, 2, streamB),
      { byURL: new Map([[streamB.url, {}]]) },
      { parkUnused: true },
    )

    // Collapse, but the cell `other` used to occupy was cleared while
    // expanded: the normal layout no longer has any box for streamA.
    const viewContentMap: ViewContentMap = new Map([['1', streamB]])
    sw.setViews(viewContentMap, { byURL: new Map([[streamB.url, {}]]) })

    // The parked actor is genuinely no longer needed, so it is torn down
    // instead of being parked forever.
    expect(other.stop).toHaveBeenCalled()
    expect(other.disposeView).toHaveBeenCalledTimes(1)
    expect(
      (sw as unknown as { parkedViews: Map<number, unknown> }).parkedViews.has(
        2,
      ),
    ).toBe(false)
  })
})

describe('StreamWindow parking pauses playback when pauseParkedViews is enabled (issue #374)', () => {
  it('sends PAUSE to a view when it is parked', () => {
    const sw = makeStreamWindow(makeConfig({ cols: 2, rows: 2 }))
    sw.pauseParkedViews = true
    sw.win = {
      contentView: { removeChildView: vi.fn() },
    } as unknown as InstanceType<typeof StreamWindow>['win']

    const streamA: ViewContent = { url: 'https://example.com/a', kind: 'video' }
    const streamB: ViewContent = { url: 'https://example.com/b', kind: 'video' }
    const expanding = makeReuseTestActor({
      id: 1,
      content: streamB,
      spaces: [1],
      running: true,
    })
    const other = makeReuseTestActor({
      id: 2,
      content: streamA,
      spaces: [0],
      running: true,
    })
    sw.views = new Map([
      [1, expanding.actor],
      [2, other.actor],
    ])
    sw.createView = vi.fn()

    sw.setViews(
      fullscreenViewContentMap(2, 2, streamB),
      { byURL: new Map([[streamB.url, {}]]) },
      { parkUnused: true },
    )

    expect(other.send).toHaveBeenCalledWith({ type: 'PAUSE' })
  })

  it('does not send PAUSE to a parked view when pauseParkedViews is disabled (default)', () => {
    const sw = makeStreamWindow(makeConfig({ cols: 2, rows: 2 }))
    sw.win = {
      contentView: { removeChildView: vi.fn() },
    } as unknown as InstanceType<typeof StreamWindow>['win']

    const streamA: ViewContent = { url: 'https://example.com/a', kind: 'video' }
    const streamB: ViewContent = { url: 'https://example.com/b', kind: 'video' }
    const expanding = makeReuseTestActor({
      id: 1,
      content: streamB,
      spaces: [1],
      running: true,
    })
    const other = makeReuseTestActor({
      id: 2,
      content: streamA,
      spaces: [0],
      running: true,
    })
    sw.views = new Map([
      [1, expanding.actor],
      [2, other.actor],
    ])
    sw.createView = vi.fn()

    sw.setViews(
      fullscreenViewContentMap(2, 2, streamB),
      { byURL: new Map([[streamB.url, {}]]) },
      { parkUnused: true },
    )

    expect(other.send).not.toHaveBeenCalledWith({ type: 'PAUSE' })
  })

  it('sends RESUME to a previously-parked view once it is reused after collapse', () => {
    const sw = makeStreamWindow(makeConfig({ cols: 2, rows: 2 }))
    sw.pauseParkedViews = true
    sw.win = {
      contentView: { removeChildView: vi.fn() },
    } as unknown as InstanceType<typeof StreamWindow>['win']

    const streamA: ViewContent = { url: 'https://example.com/a', kind: 'video' }
    const streamB: ViewContent = { url: 'https://example.com/b', kind: 'video' }
    const expanding = makeReuseTestActor({
      id: 1,
      content: streamB,
      spaces: [1],
      running: true,
    })
    const other = makeReuseTestActor({
      id: 2,
      content: streamA,
      spaces: [0],
      running: true,
    })
    sw.views = new Map([
      [1, expanding.actor],
      [2, other.actor],
    ])
    sw.createView = vi.fn()

    // Expand: `other` is parked and paused.
    sw.setViews(
      fullscreenViewContentMap(2, 2, streamB),
      { byURL: new Map([[streamB.url, {}]]) },
      { parkUnused: true },
    )
    expect(other.send).toHaveBeenCalledWith({ type: 'PAUSE' })

    // Collapse: the normal per-cell layout is restored, reusing `other`.
    const viewContentMap: ViewContentMap = new Map([
      ['0', streamA],
      ['1', streamB],
    ])
    sw.setViews(viewContentMap, {
      byURL: new Map([
        [streamA.url, {}],
        [streamB.url, {}],
      ]),
    })

    expect(other.send).toHaveBeenCalledWith({ type: 'RESUME' })
  })

  it('does not send RESUME to a view that was reused but was never parked', () => {
    const sw = makeStreamWindow(makeConfig({ cols: 1, rows: 1 }))
    sw.pauseParkedViews = true
    sw.win = {
      contentView: { removeChildView: vi.fn() },
    } as unknown as InstanceType<typeof StreamWindow>['win']

    const streamA: ViewContent = { url: 'https://example.com/a', kind: 'video' }
    const actor = makeReuseTestActor({
      id: 1,
      content: streamA,
      spaces: [0],
      running: true,
    })
    sw.views = new Map([[1, actor.actor]])
    sw.createView = vi.fn()

    // Ordinary re-display of an already-running, never-parked view.
    sw.setViews(new Map([['0', streamA]]), {
      byURL: new Map([[streamA.url, {}]]),
    })

    expect(actor.send).not.toHaveBeenCalledWith({ type: 'RESUME' })
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

describe('StreamWindow constructor', () => {
  beforeEach(() => {
    electronStub.windows.length = 0
    electronStub.webContentsViews.length = 0
    electronStub.ipcMain.handle.mockClear()
    electronStub.ipcMain.on.mockClear()
    vi.mocked(loadHTML).mockClear()
  })

  function contentViewOf(win: InstanceType<typeof StreamWindow>['win']) {
    return (
      win as unknown as {
        contentView: { addChildView: ReturnType<typeof vi.fn> }
      }
    ).contentView
  }

  it('creates the wall window, then the background layer, then the overlay layer', () => {
    const sw = new StreamWindow(makeConfig())

    // The window must exist before the layers, which are added as its children.
    expect(electronStub.windows).toHaveLength(1)
    expect(sw.win).toBe(electronStub.windows[0])

    // Creation order is load-bearing: `addChildView` stacks children in call
    // order, so the background layer has to be added before the overlay or
    // the overlay ends up painted underneath it.
    expect(electronStub.webContentsViews).toEqual([
      sw.backgroundView,
      sw.overlayView,
    ])
    expect(
      contentViewOf(sw.win).addChildView.mock.calls.map(([view]) => view),
    ).toEqual([sw.backgroundView, sw.overlayView])

    // Each layer loads its own page, in the same order.
    expect(vi.mocked(loadHTML).mock.calls.map(([, page]) => page)).toEqual([
      'background',
      'overlay',
    ])
    expect(vi.mocked(loadHTML).mock.calls[0][0]).toBe(
      sw.backgroundView.webContents,
    )
    expect(vi.mocked(loadHTML).mock.calls[1][0]).toBe(
      sw.overlayView.webContents,
    )
  })

  it('gives each layer its own web preferences and sizes it to the configured wall', () => {
    const sw = new StreamWindow(makeConfig({ width: 1280, height: 720 }))

    const prefsOf = (view: unknown) =>
      (view as { options: { webPreferences: Electron.WebPreferences } }).options
        .webPreferences
    expect(prefsOf(sw.backgroundView).contextIsolation).toBeUndefined()
    expect(prefsOf(sw.overlayView).contextIsolation).toBe(true)

    for (const layer of [sw.backgroundView, sw.overlayView]) {
      expect(layer.setBounds).toHaveBeenCalledWith({
        x: 0,
        y: 0,
        width: 1280,
        height: 720,
      })
    }
  })

  it('starts with empty view bookkeeping', () => {
    const sw = new StreamWindow(makeConfig())

    expect(sw.views.size).toBe(0)
    expect(sw.parkedViews.size).toBe(0)
    expect(sw.viewsByWebContentsId.size).toBe(0)
    expect(sw.pauseParkedViews).toBe(false)
  })

  it('registers the IPC handlers once both layers exist', () => {
    const sw = new StreamWindow(makeConfig())

    expect(electronStub.ipcMain.handle.mock.calls.map(([ch]) => ch)).toEqual([
      'layer:load',
      'view-init',
    ])
    expect(electronStub.ipcMain.on.mock.calls.map(([ch]) => ch)).toEqual([
      'view-loaded',
      'view-stalled',
      'view-info',
      'view-error',
      'devtools-overlay',
    ])

    // The `layer:load` handler closes over both layer views, so it can only
    // be registered after they have been created. Driving it proves the
    // wiring, not just the registration.
    const layerLoad = electronStub.ipcMain.handle.mock.calls.find(
      ([channel]) => channel === 'layer:load',
    )?.[1] as (ev: { sender: unknown }) => void
    let loads = 0
    sw.on('load', () => {
      loads++
    })

    layerLoad({ sender: sw.backgroundView.webContents })
    layerLoad({ sender: sw.overlayView.webContents })
    layerLoad({ sender: {} })

    expect(loads).toBe(2)
  })
})
