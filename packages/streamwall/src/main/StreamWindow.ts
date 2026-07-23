import assert from 'assert'
import {
  BrowserWindow,
  Event as ElectronEvent,
  ipcMain,
  screen,
  WebContents,
  WebContentsView,
} from 'electron'
import EventEmitter from 'events'
import path from 'path'
import {
  asViewId,
  boxesFromViewContentMap,
  CellIdx,
  computeBoxRect,
  ContentDisplayOptions,
  StreamData,
  StreamList,
  StreamwallState,
  StreamWindowConfig,
  ViewContentMap,
  ViewId,
  ViewState,
} from 'streamwall-shared'
import { createActor, EventFrom, SnapshotFrom } from 'xstate'
import { devServerOrigin, loadHTML } from './loadHTML'
import log from './logger'
import { secureStreamView } from './navigationSecurity'
import { allocateViewPartition, hardenSession } from './partitions'
import { planViewLayout, type ViewCandidate } from './viewLayoutPlan'
import viewStateMachine, {
  DEFAULT_RETRY_CONFIG,
  RetryConfig,
  ViewActor,
} from './viewStateMachine'
import { resolveWindowPlacement } from './windowPlacement'

function getDisplayOptions(stream: StreamData): ContentDisplayOptions {
  if (!stream) {
    return {}
  }
  const { rotation } = stream
  return { rotation }
}

/**
 * One box of the requested wall layout, as produced by
 * `boxesFromViewContentMap`: its grid geometry, the cells it covers and the
 * content it asks for.
 */
type LayoutBox = ReturnType<typeof boxesFromViewContentMap>[number]

export interface StreamWindowEventMap {
  load: []
  close: [ElectronEvent]
  state: [ViewState[]]
  resize: []
}

export default class StreamWindow extends EventEmitter<StreamWindowEventMap> {
  config: StreamWindowConfig
  retryConfig: RetryConfig
  // Whether a parked (hidden) view also has its underlying media playback
  // paused, instead of being kept fully live off-screen. Optional (issue
  // #374): trades the parked view's instant-resume smoothness for lower
  // CPU/network usage while it's hidden behind a fullscreen expansion.
  pauseParkedViews: boolean
  win: BrowserWindow
  backgroundView: WebContentsView
  overlayView: WebContentsView
  views: Map<ViewId, ViewActor>
  // Actors temporarily excluded from `views` (and therefore from
  // `emitState()`) while a fullscreen expansion hides them behind the
  // expanded view, kept alive instead of torn down so a later collapse can
  // reposition them without a reload (issue #369). Populated by `setViews`
  // when called with `{ parkUnused: true }`; cleared and re-considered as
  // reuse candidates on every subsequent `setViews` call.
  parkedViews: Map<ViewId, ViewActor>
  // Routes IPC messages from a specific WebContentsView back to whichever
  // actor owns it. Keyed by live `webContents.id`, unlike `views` (keyed by
  // each actor's stable `context.id`, fixed at creation): once a content swap
  // (see viewStateMachine's `running.swap`) promotes a preloaded view to be
  // an actor's current one, that view's webContents.id generally differs
  // from the actor's original `context.id`, so routing needs its own map.
  viewsByWebContentsId: Map<number, ViewActor>
  // Teardown thunks for every ipcMain handler/listener registered by
  // `setupIpcHandlers`. `ipcMain` is a process-global singleton and
  // `ipcMain.handle` throws on duplicate channel registration, so these are
  // used by `dispose()` to release the channels when this window goes away
  // (otherwise constructing a second StreamWindow -- e.g. a future
  // recreate-on-config-reload path -- would crash). Filled in the constructor.
  private ipcTeardowns: Array<() => void> = []

  constructor(
    config: StreamWindowConfig,
    retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG,
    pauseParkedViews = false,
  ) {
    super()
    this.config = config
    this.retryConfig = retryConfig
    this.pauseParkedViews = pauseParkedViews
    this.views = new Map()
    this.parkedViews = new Map()
    this.viewsByWebContentsId = new Map()

    // Sequenced setup: the window must exist before the layer views can be
    // added to it, and both layers must exist before the IPC handlers that
    // reference them are registered.
    this.win = this.createWallWindow()
    this.backgroundView = this.createLayerView('background', {
      preload: path.join(__dirname, 'layerPreload.js'),
    })
    this.overlayView = this.createLayerView('overlay', {
      contextIsolation: true,
      preload: path.join(__dirname, 'layerPreload.js'),
    })
    this.setupIpcHandlers()
  }

  /**
   * Creates the wall's BrowserWindow on the configured display and wires its
   * lifecycle events (close, first show, resize) to this StreamWindow.
   */
  private createWallWindow(): BrowserWindow {
    const {
      width,
      height,
      x,
      y,
      frameless,
      fullscreen,
      display,
      backgroundColor,
    } = this.config
    // Resolve which monitor and geometry to open on. Done here (not at config
    // parse time) because the display list only exists once Electron is ready.
    const { placement, warning } = resolveWindowPlacement(
      { x, y, width, height, display, fullscreen },
      screen.getAllDisplays(),
    )
    if (warning) {
      console.warn(warning)
    }
    const win = new BrowserWindow({
      title: 'Streamwall',
      x: placement.x,
      y: placement.y,
      width: placement.width,
      height: placement.height,
      fullscreen: placement.fullscreen,
      frame: !frameless,
      backgroundColor,
      useContentSize: true,
      show: false,
    })
    win.removeMenu()
    win.loadURL('about:blank')
    win.on('close', (event) => this.emit('close', event))

    win.once('ready-to-show', () => {
      win.show()
    })

    // Keep the wall responsive: when the window is resized / maximized /
    // fullscreened, rescale the background, overlay and stream views to fill
    // the new content area.
    win.on('resize', () => this.handleResize())

    return win
  }

  /**
   * Creates one of the two transparent full-window chrome layers (the
   * background and the overlay), sizes it to the configured wall dimensions
   * and loads its HTML entry point.
   */
  private createLayerView(
    page: 'background' | 'overlay',
    webPreferences: Electron.WebPreferences,
  ): WebContentsView {
    const { width, height } = this.config
    const layerView = new WebContentsView({ webPreferences })
    layerView.setBackgroundColor('#0000')
    this.win.contentView.addChildView(layerView)
    layerView.setBounds({
      x: 0,
      y: 0,
      width,
      height,
    })
    // A superseded load rejects with ERR_ABORTED; log it so it leaves a
    // breadcrumb instead of an unhandled promise rejection (issue #392/#626).
    loadHTML(layerView.webContents, page).catch((err) => {
      log.warn('error loading chrome layer', page, err)
    })
    return layerView
  }

  /**
   * Registers an `ipcMain.handle` invoke handler and records how to remove it
   * again, so `dispose()` can release the (process-global) channel.
   */
  private registerIpcHandle(
    channel: string,
    listener: Parameters<typeof ipcMain.handle>[1],
  ) {
    ipcMain.handle(channel, listener)
    this.ipcTeardowns.push(() => ipcMain.removeHandler(channel))
  }

  /**
   * Registers an `ipcMain.on` event listener and records how to remove it
   * again (by the exact listener reference), so `dispose()` can detach it.
   */
  private registerIpcOn(
    channel: string,
    listener: Parameters<typeof ipcMain.on>[1],
  ) {
    ipcMain.on(channel, listener)
    this.ipcTeardowns.push(() => ipcMain.removeListener(channel, listener))
  }

  /**
   * Registers the main-process IPC handlers: the chrome layers' load
   * notification, and the per-view messages routed back to the owning actor
   * via `viewsByWebContentsId`. Every registration is recorded so `dispose()`
   * can tear it down -- `ipcMain` is a process-global singleton and
   * `ipcMain.handle` throws on duplicate channel registration.
   */
  private setupIpcHandlers() {
    this.registerIpcHandle('layer:load', (ev) => {
      if (
        ev.sender !== this.backgroundView.webContents &&
        ev.sender !== this.overlayView.webContents
      ) {
        return
      }
      this.emit('load')
    })

    // Whether this IPC message came from the view an actor is currently
    // preloading in the background (see viewStateMachine's `running.swap`),
    // as opposed to the one it's actively displaying -- so the two can be
    // routed to distinct events instead of being conflated.
    const isFromNextView = (actor: ViewActor, senderId: number) =>
      actor.getSnapshot().context.next?.view.webContents.id === senderId

    this.registerIpcHandle('view-init', async (ev) => {
      const view = this.viewsByWebContentsId.get(ev.sender.id)
      if (!view) {
        return
      }
      const { content, options, volume, desiredPaused } =
        view.getSnapshot().context
      view.send({
        type: isFromNextView(view, ev.sender.id)
          ? 'NEXT_VIEW_INIT'
          : 'VIEW_INIT',
      })
      // The desired paused state rides along so a fresh view -- in
      // particular a background preload for a parked (paused) cell --
      // initializes paused instead of playing until the post-swap 'pause'
      // IPC arrives (issue #658).
      return { content, options, volume, paused: desiredPaused }
    })
    this.registerIpcOn('view-loaded', (ev) => {
      const view = this.viewsByWebContentsId.get(ev.sender.id)
      if (!view) {
        return
      }
      view.send({
        type: isFromNextView(view, ev.sender.id)
          ? 'NEXT_VIEW_LOADED'
          : 'VIEW_LOADED',
      })
    })
    this.registerIpcOn('view-stalled', (ev) => {
      this.viewsByWebContentsId.get(ev.sender.id)?.send({
        type: 'VIEW_STALLED',
      })
    })
    this.registerIpcOn('view-info', (ev, { info }) => {
      this.viewsByWebContentsId.get(ev.sender.id)?.send({
        type: 'VIEW_INFO',
        info,
      })
    })
    this.registerIpcOn('view-error', (ev, { error }) => {
      const view = this.viewsByWebContentsId.get(ev.sender.id)
      if (!view) {
        return
      }
      view.send({
        type: isFromNextView(view, ev.sender.id)
          ? 'NEXT_VIEW_ERROR'
          : 'VIEW_ERROR',
        error,
      })
    })
    this.registerIpcOn('devtools-overlay', () => {
      // The handler outlives the window, so the overlay's webContents may
      // already be gone by the time this fires; opening devtools on a
      // destroyed webContents throws.
      const { webContents } = this.overlayView
      if (webContents.isDestroyed()) {
        return
      }
      webContents.openDevTools()
    })
  }

  /**
   * Releases every process-global `ipcMain` handler/listener registered in the
   * constructor. Must be called before this window is discarded so a later
   * StreamWindow can register the same channels again (`ipcMain.handle` throws
   * on a duplicate `layer:load`/`view-init` registration otherwise).
   * Idempotent: calling it twice is a no-op.
   */
  dispose() {
    for (const teardown of this.ipcTeardowns) {
      teardown()
    }
    this.ipcTeardowns = []
  }

  handleResize() {
    const [width, height] = this.win.getContentSize()
    if (width === this.config.width && height === this.config.height) {
      return
    }
    this.config.width = width
    this.config.height = height
    this.backgroundView.setBounds({ x: 0, y: 0, width, height })
    this.overlayView.setBounds({ x: 0, y: 0, width, height })
    // Let the main process re-layout the stream views and rebroadcast state
    // (config is shared by reference, so the overlay gets the new dimensions).
    this.emit('resize')
  }

  /**
   * Creates a bare WebContentsView + its dedicated hidden host window (used
   * while the view is loading, before it's positioned in the wall), with no
   * actor/routing attached yet. Shared by `createView()` (the initial view
   * for a new cell) and `createNextView` (a preloaded view for a content swap
   * on an already-running cell -- see viewStateMachine's `running.swap`).
   */
  private createRawView(): {
    view: WebContentsView
    offscreenWin: BrowserWindow
  } {
    const {
      config: { width, height, backgroundColor },
    } = this
    // Give every view its own unique, ephemeral partition so that streams can
    // not share cookies/localStorage/cache with each other, the browse window,
    // or anything persisted to disk.
    const view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'mediaPreload.js'),
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
        partition: allocateViewPartition(),
      },
    })
    hardenSession(view.webContents.session, {
      // In development the HLS renderer page and its assets are served from the
      // Vite dev server on loopback; allow that origin so the SSRF request guard
      // does not cancel them.
      allowedOrigins: [devServerOrigin()].filter((o) => o !== undefined),
    })
    view.setBackgroundColor(backgroundColor)

    // Lock the view to its stream URL: deny popups and block navigation/redirect
    // escapes while still allowing the page to reload itself.
    secureStreamView(view.webContents)

    // Hidden window used for loading the view before it's positioned in the wall.
    const offscreenWin = new BrowserWindow({
      width,
      height,
      show: false,
    })

    return { view, offscreenWin }
  }

  /**
   * Wires up routing/failure-reporting for a view created by
   * `createRawView()` so it's addressable by `viewsByWebContentsId` and its
   * load failures reach the given actor as the right event. Split out from
   * `createRawView()` because it needs the actor, which doesn't exist yet
   * when the very first view for a new cell is created.
   */
  private registerView(view: WebContentsView, actor: ViewActor) {
    const viewId = view.webContents.id
    this.viewsByWebContentsId.set(viewId, actor)

    // Surface main-frame load failures (e.g. ERR_NAME_NOT_RESOLVED) as view
    // errors so the state machine leaves the loading state instead of hanging.
    // loadPage intentionally does not await loadURL — awaiting would delay the
    // navigate->waitForInit transition past the preload's early VIEW_INIT and
    // hang every view — so failures are reported here instead.
    view.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
        // -3 is ERR_ABORTED: superseded navigation or self-reload, not a failure.
        if (!isMainFrame || errorCode === -3) {
          return
        }
        const error = new Error(
          `Failed to load (${errorCode}): ${errorDescription}`,
        )
        const { context } = actor.getSnapshot()
        if (context.next?.view.webContents.id === viewId) {
          actor.send({ type: 'NEXT_VIEW_ERROR', error })
        } else if (context.view.webContents.id === viewId) {
          // Otherwise this view has since been retired (e.g. a swap promoted
          // a different one to current) -- ignore the stale event.
          actor.send({ type: 'VIEW_ERROR', error })
        }
      },
    )
  }

  /** Tears down a view + host window created by `createRawView()`. */
  private disposeRawView(view: WebContentsView, offscreenWin: BrowserWindow) {
    this.viewsByWebContentsId.delete(view.webContents.id)
    offscreenWin.contentView.removeChildView(view)
    this.win.contentView.removeChildView(view)
    view.webContents.close()
    offscreenWin.destroy()
  }

  /**
   * Moves a running actor's view off the visible wall onto its own offscreen
   * host window, without touching the actor's state. Used to keep a
   * non-focused view alive (rather than torn down) across a fullscreen
   * expansion: `setViews`' own matchers can then find and reposition it again
   * on collapse -- via a normal `DISPLAY` event -- instead of recreating it
   * from scratch (issue #369). Mirrors `viewStateMachine`'s `offscreenView`
   * action, which the actor itself uses while a fresh view is loading.
   */
  private hideView(actor: ViewActor) {
    const { view, win, offscreenWin } = actor.getSnapshot().context
    win.contentView.removeChildView(view)
    offscreenWin.contentView.addChildView(view)
    const { width, height } = offscreenWin.getBounds()
    view.setBounds({ x: 0, y: 0, width, height })
    if (this.pauseParkedViews) {
      actor.send({ type: 'PAUSE' })
    }
  }

  createView() {
    const { win } = this
    assert(win != null, 'Window must be initialized')

    const { view, offscreenWin } = this.createRawView()
    // The actor's stable identity for its whole lifetime (issue #397), which
    // is why it is a `ViewId` rather than a plain cell-sized number (#507).
    const viewId = asViewId(view.webContents.id)

    // Forward-declared: `createNextView` closes over `actor` but must be
    // built before `createActor()` returns it, since it's part of that same
    // call's `input`. Assigned exactly once, right below.
    // eslint-disable-next-line prefer-const
    let actor!: ViewActor
    const createNextView = () => {
      const next = this.createRawView()
      this.registerView(next.view, actor)
      return next
    }

    actor = createActor(viewStateMachine, {
      input: {
        id: viewId,
        view,
        win,
        offscreenWin,
        retry: this.retryConfig,
        createNextView,
        disposeView: (v: WebContentsView, w: BrowserWindow) =>
          this.disposeRawView(v, w),
      },
    })
    this.registerView(view, actor)

    let lastSnapshot: SnapshotFrom<typeof viewStateMachine> | undefined
    actor.subscribe((snapshot) => {
      if (snapshot === lastSnapshot) {
        return
      }
      lastSnapshot = snapshot
      this.emitState()
    })

    actor.start()

    return actor
  }

  emitState() {
    const states = Array.from(this.views.values(), (actor) => {
      const { value, context } = actor.getSnapshot()
      return {
        state: value,
        context: {
          id: context.id,
          content: context.content,
          info: context.info,
          pos: context.pos,
          error: context.error,
          volume: context.volume,
        },
      } satisfies ViewState
    })
    this.emit('state', states)
  }

  /**
   * Reconfigures the grid dimensions at runtime. The actual re-layout happens on
   * the next `setViews()` call (driven by the server after it remaps the views
   * state), which reads `cols`/`rows` from `this.config`.
   *
   * Mutates `this.config` in place rather than replacing it: the main process
   * shares a single config object across `streamWindow.config`,
   * `clientState.config` and the resize pipeline (`handleResize` likewise
   * mutates it in place). Replacing the object would detach those references and
   * leave the overlay/control grid drawing stale dimensions after the next
   * resize.
   */
  setGridSize(cols: number, rows: number) {
    this.config.cols = cols
    this.config.rows = rows
  }

  /**
   * Describes every actor eligible for reuse by the next `setViews` call, in
   * the priority order `planViewLayout` resolves ties by: live views first,
   * then views parked by a previous `parkUnused` call -- which are reuse
   * candidates too, so a fullscreen collapse can find and reposition them
   * instead of creating new ones (issue #369).
   */
  private reuseCandidates(): Array<ViewCandidate<ViewActor>> {
    return [...this.views.values(), ...this.parkedViews.values()].map(
      (view) => {
        const snapshot = view.getSnapshot()
        return {
          view,
          content: snapshot.context.content,
          spaces: snapshot.context.pos?.spaces,
          isRunning: snapshot.matches({ displaying: 'running' }),
        }
      },
    )
  }

  /**
   * Applies the reuse/creation half of a layout plan: positions each assigned
   * actor in its box and returns the new `views` map. Any actor whose box
   * turns out to be unusable (no content, or a URL missing from `streams`) is
   * added to `unusedViews` so the caller's teardown pass reclaims it --
   * dropping the reference outright would leak the actor, its
   * WebContentsView and its offscreen BrowserWindow permanently.
   */
  private displayPlannedViews(
    viewsToDisplay: Array<{ box: LayoutBox; view: ViewActor }>,
    streams: StreamList,
    previouslyParkedIds: Set<ViewId>,
    unusedViews: Set<ViewActor>,
  ): Map<ViewId, ViewActor> {
    const { width, height, cols, rows } = this.config
    const newViews = new Map<ViewId, ViewActor>()
    for (const { box, view } of viewsToDisplay) {
      const { content, spaces } = box
      if (!content) {
        unusedViews.add(view)
        continue
      }

      const stream = streams.byURL?.get(content.url)
      if (!stream) {
        unusedViews.add(view)
        continue
      }

      const pos = {
        ...computeBoxRect(cols, rows, width, height, box),
        spaces,
      }

      view.send({ type: 'DISPLAY', pos, content })
      view.send({ type: 'OPTIONS', options: getDisplayOptions(stream) })
      const viewId = view.getSnapshot().context.id
      if (this.pauseParkedViews && previouslyParkedIds.has(viewId)) {
        view.send({ type: 'RESUME' })
      }
      newViews.set(viewId, view)
    }
    return newViews
  }

  /**
   * Applies the leftover half of a layout plan: every actor no box claimed is
   * either parked (kept alive but hidden, see `hideView` and the
   * `parkedViews` field) or stopped and fully disposed.
   */
  private retireUnusedViews(unusedViews: Set<ViewActor>, parkUnused: boolean) {
    for (const view of unusedViews) {
      if (parkUnused) {
        this.hideView(view)
        this.parkedViews.set(view.getSnapshot().context.id, view)
        continue
      }
      view.stop()
      const {
        view: contentView,
        offscreenWin,
        next,
        disposeView,
      } = view.getSnapshot().context
      disposeView(contentView, offscreenWin)
      // A preload can still be in flight for a cell being torn down entirely
      // (as opposed to just interrupted -- see viewStateMachine's `running.
      // exit` -- this covers the case where the whole actor is discarded);
      // dispose it too so its WebContentsView/offscreen window don't leak.
      if (next) {
        disposeView(next.view, next.offscreenWin)
      }
    }
  }

  setViews(
    viewContentMap: ViewContentMap,
    streams: StreamList,
    { parkUnused = false }: { parkUnused?: boolean } = {},
  ) {
    const { cols, rows } = this.config
    const boxes = boxesFromViewContentMap(cols, rows, viewContentMap)

    // Snapshot which actor ids were parked coming into this call, so a view
    // matched back into a box below can be told to resume playback (issue
    // #374) -- `this.parkedViews` itself is cleared right after and
    // repopulated with whatever is still unused once this call is done.
    const previouslyParkedIds = new Set(this.parkedViews.keys())

    // Decide reuse vs. teardown vs. creation up front, then just execute it.
    const plan = planViewLayout(boxes, this.reuseCandidates())
    this.parkedViews.clear()

    const unusedViews = new Set(plan.unusedViews)
    const viewsToDisplay = [
      ...plan.reused,
      ...plan.unmatchedBoxes.map((box) => ({ box, view: this.createView() })),
    ]

    const newViews = this.displayPlannedViews(
      viewsToDisplay,
      streams,
      previouslyParkedIds,
      unusedViews,
    )
    this.retireUnusedViews(unusedViews, parkUnused)
    this.views = newViews
    this.emitState()
  }

  setListeningView(viewId: ViewId | null) {
    // Address the listening view by its stable id, not by grid cell, so a
    // concurrent resize can't redirect "listen" to whatever tile now sits at
    // an index (issue #397). `this.views` is keyed by each actor's stable
    // `context.id`, so the map key is that id.
    for (const [id, view] of this.views) {
      const snapshot = view.getSnapshot()
      if (!snapshot.matches('displaying')) {
        continue
      }
      const isSelectedView = viewId != null && id === viewId
      view.send({ type: isSelectedView ? 'UNMUTE' : 'MUTE' })
    }
  }

  findViewById(viewId: ViewId) {
    // O(1) lookup by stable id: `this.views` is keyed by each actor's
    // creation-time `context.id`, which survives grid resizes and remaps
    // (issue #397), unlike a grid cell index.
    return this.views.get(viewId)
  }

  sendViewEvent(viewId: ViewId, event: EventFrom<typeof viewStateMachine>) {
    const view = this.findViewById(viewId)
    if (view) {
      view.send(event)
    }
  }

  /**
   * The top-left grid cell the view with `viewId` currently occupies, or null
   * when it has no placement or no such view exists. Translates a stable view
   * id into the cell-based `fullscreenViewIdx` the layout state still keys on
   * (issue #397), resolved against the live layout so a resize racing the
   * command can't select the wrong cell.
   */
  getViewAnchorIdx(viewId: ViewId): CellIdx | null {
    return (
      this.findViewById(viewId)?.getSnapshot().context.pos?.spaces[0] ?? null
    )
  }

  setViewBackgroundListening(viewId: ViewId, listening: boolean) {
    this.sendViewEvent(viewId, {
      type: listening ? 'BACKGROUND' : 'UNBACKGROUND',
    })
  }

  setViewBlurred(viewId: ViewId, blurred: boolean) {
    this.sendViewEvent(viewId, { type: blurred ? 'BLUR' : 'UNBLUR' })
  }

  setViewVolume(viewId: ViewId, volume: number) {
    this.sendViewEvent(viewId, { type: 'SET_VOLUME', volume })
  }

  reloadView(viewId: ViewId) {
    this.sendViewEvent(viewId, { type: 'RELOAD' })
  }

  openDevTools(viewId: ViewId, inWebContents: WebContents) {
    this.sendViewEvent(viewId, { type: 'DEVTOOLS', inWebContents })
  }

  onState(state: StreamwallState) {
    // A layer's webContents may already be gone during window teardown (or a
    // future recreate flow); sending to a destroyed webContents throws. Same
    // guard as the `devtools-overlay` handler (issue #651).
    for (const layerView of [this.overlayView, this.backgroundView]) {
      const { webContents } = layerView
      if (!webContents.isDestroyed()) {
        webContents.send('state', state)
      }
    }

    for (const view of this.views.values()) {
      const { content } = view.getSnapshot().context
      if (!content) {
        continue
      }

      const { url } = content
      const stream = state.streams.byURL?.get(url)
      if (stream) {
        view.send({
          type: 'OPTIONS',
          options: getDisplayOptions(stream),
        })
      }
    }
  }
}
