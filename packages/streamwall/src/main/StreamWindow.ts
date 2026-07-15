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
import intersection from 'lodash/intersection'
import isEqual from 'lodash/isEqual'
import path from 'path'
import {
  boxesFromViewContentMap,
  computeBoxRect,
  ContentDisplayOptions,
  StreamData,
  StreamList,
  StreamwallState,
  StreamWindowConfig,
  ViewContent,
  ViewContentMap,
  ViewState,
} from 'streamwall-shared'
import { createActor, EventFrom, SnapshotFrom } from 'xstate'
import { devServerOrigin, loadHTML } from './loadHTML'
import { secureStreamView } from './navigationSecurity'
import { allocateViewPartition, hardenSession } from './partitions'
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

export interface StreamWindowEventMap {
  load: []
  close: [ElectronEvent]
  state: [ViewState[]]
  resize: []
}

export default class StreamWindow extends EventEmitter<StreamWindowEventMap> {
  config: StreamWindowConfig
  retryConfig: RetryConfig
  win: BrowserWindow
  backgroundView: WebContentsView
  overlayView: WebContentsView
  views: Map<number, ViewActor>
  // Actors temporarily excluded from `views` (and therefore from
  // `emitState()`) while a fullscreen expansion hides them behind the
  // expanded view, kept alive instead of torn down so a later collapse can
  // reposition them without a reload (issue #369). Populated by `setViews`
  // when called with `{ parkUnused: true }`; cleared and re-considered as
  // reuse candidates on every subsequent `setViews` call.
  parkedViews: Map<number, ViewActor>
  // Routes IPC messages from a specific WebContentsView back to whichever
  // actor owns it. Keyed by live `webContents.id`, unlike `views` (keyed by
  // each actor's stable `context.id`, fixed at creation): once a content swap
  // (see viewStateMachine's `running.swap`) promotes a preloaded view to be
  // an actor's current one, that view's webContents.id generally differs
  // from the actor's original `context.id`, so routing needs its own map.
  viewsByWebContentsId: Map<number, ViewActor>

  constructor(
    config: StreamWindowConfig,
    retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG,
  ) {
    super()
    this.config = config
    this.retryConfig = retryConfig
    this.views = new Map()
    this.parkedViews = new Map()
    this.viewsByWebContentsId = new Map()

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

    this.win = win

    const backgroundView = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'layerPreload.js'),
      },
    })
    backgroundView.setBackgroundColor('#0000')
    win.contentView.addChildView(backgroundView)
    backgroundView.setBounds({
      x: 0,
      y: 0,
      width,
      height,
    })
    loadHTML(backgroundView.webContents, 'background')
    this.backgroundView = backgroundView

    const overlayView = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        preload: path.join(__dirname, 'layerPreload.js'),
      },
    })
    overlayView.setBackgroundColor('#0000')
    win.contentView.addChildView(overlayView)
    overlayView.setBounds({
      x: 0,
      y: 0,
      width,
      height,
    })
    loadHTML(overlayView.webContents, 'overlay')
    this.overlayView = overlayView

    ipcMain.handle('layer:load', (ev) => {
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

    ipcMain.handle('view-init', async (ev) => {
      const view = this.viewsByWebContentsId.get(ev.sender.id)
      if (!view) {
        return
      }
      const { content, options, volume } = view.getSnapshot().context
      view.send({
        type: isFromNextView(view, ev.sender.id)
          ? 'NEXT_VIEW_INIT'
          : 'VIEW_INIT',
      })
      return { content, options, volume }
    })
    ipcMain.on('view-loaded', (ev) => {
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
    ipcMain.on('view-stalled', (ev) => {
      this.viewsByWebContentsId.get(ev.sender.id)?.send({
        type: 'VIEW_STALLED',
      })
    })
    ipcMain.on('view-info', (ev, { info }) => {
      this.viewsByWebContentsId.get(ev.sender.id)?.send({
        type: 'VIEW_INFO',
        info,
      })
    })
    ipcMain.on('view-error', (ev, { error }) => {
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
    ipcMain.on('devtools-overlay', () => {
      overlayView.webContents.openDevTools()
    })
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
  }

  createView() {
    const { win } = this
    assert(win != null, 'Window must be initialized')

    const { view, offscreenWin } = this.createRawView()
    const viewId = view.webContents.id

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

  setViews(
    viewContentMap: ViewContentMap,
    streams: StreamList,
    { parkUnused = false }: { parkUnused?: boolean } = {},
  ) {
    const { width, height, cols, rows } = this.config
    const { views } = this
    const boxes = boxesFromViewContentMap(cols, rows, viewContentMap)
    const remainingBoxes = new Set(boxes)
    // Views parked by a previous `parkUnused` call are reuse candidates too,
    // so a fullscreen collapse can find and reposition them via the matchers
    // below instead of creating new ones (issue #369).
    const unusedViews = new Set([
      ...views.values(),
      ...this.parkedViews.values(),
    ])
    this.parkedViews.clear()
    const viewsToDisplay = []

    // We try to find the best match for moving / reusing existing views to match the new positions.
    const matchers: Array<
      (
        v: SnapshotFrom<typeof viewStateMachine>,
        content: ViewContent | undefined,
        spaces?: number[],
      ) => boolean
    > = [
      // First try to find a loaded view of the same URL in the same space...
      (v, content, spaces) =>
        isEqual(v.context.content, content) &&
        v.matches({ displaying: 'running' }) &&
        intersection(v.context.pos?.spaces, spaces).length > 0,
      // Then try to find a loaded view of the same URL...
      (v, content) =>
        isEqual(v.context.content, content) &&
        v.matches({ displaying: 'running' }),
      // Then try view with the same URL that is still loading...
      (v, content) => isEqual(v.context.content, content),
      // Finally, if no view already shows this content, reuse whichever
      // running view already occupies the box's space regardless of its
      // content, so a genuine content change (a playlist advance, a
      // drag-to-place reassignment) reuses the actor already there via a
      // DISPLAY event -- letting `running`'s own swap handling take over --
      // instead of always tearing it down and creating a brand-new one.
      // Scoped to `running` only: `loading`/`error` have no DISPLAY handler
      // of their own for changed content, so the event would bubble up to
      // `displaying`'s handler, whose `contentUnchanged` guard would then
      // silently drop it and strand the actor on its old content.
      (v, _content, spaces) =>
        v.matches({ displaying: 'running' }) &&
        intersection(v.context.pos?.spaces, spaces).length > 0,
    ]

    for (const matcher of matchers) {
      for (const box of remainingBoxes) {
        const { content, spaces } = box
        let foundView
        for (const view of unusedViews) {
          const snapshot = view.getSnapshot()
          if (matcher(snapshot, content, spaces)) {
            foundView = view
            break
          }
        }
        if (foundView) {
          viewsToDisplay.push({ box, view: foundView })
          unusedViews.delete(foundView)
          remainingBoxes.delete(box)
        }
      }
    }

    for (const box of remainingBoxes) {
      const view = this.createView()
      viewsToDisplay.push({ box, view })
    }

    const newViews = new Map()
    for (const { box, view } of viewsToDisplay) {
      const { content, spaces } = box
      if (!content) {
        // Route through the teardown path below instead of dropping the
        // reference outright, or the actor/WebContentsView/offscreen
        // BrowserWindow behind it leaks permanently.
        unusedViews.add(view)
        continue
      }

      const stream = streams.byURL?.get(content.url)
      if (!stream) {
        // Same leak risk as above, for a box whose URL isn't in `streams.byURL`.
        unusedViews.add(view)
        continue
      }

      const pos = {
        ...computeBoxRect(cols, rows, width, height, box),
        spaces,
      }

      view.send({ type: 'DISPLAY', pos, content })
      view.send({ type: 'OPTIONS', options: getDisplayOptions(stream) })
      newViews.set(view.getSnapshot().context.id, view)
    }
    for (const view of unusedViews) {
      if (parkUnused) {
        // Keep the actor alive, just hidden -- see `hideView` and the
        // `parkedViews` field.
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
    this.views = newViews
    this.emitState()
  }

  setListeningView(viewIdx: number | null) {
    const { views } = this
    for (const view of views.values()) {
      const snapshot = view.getSnapshot()
      if (!snapshot.matches('displaying')) {
        continue
      }
      const { context } = snapshot
      const isSelectedView =
        viewIdx != null
          ? (context.pos?.spaces.includes(viewIdx) ?? false)
          : false
      view.send({ type: isSelectedView ? 'UNMUTE' : 'MUTE' })
    }
  }

  findViewByIdx(viewIdx: number) {
    for (const view of this.views.values()) {
      if (view.getSnapshot().context.pos?.spaces?.includes?.(viewIdx)) {
        return view
      }
    }
  }

  sendViewEvent(viewIdx: number, event: EventFrom<typeof viewStateMachine>) {
    const view = this.findViewByIdx(viewIdx)
    if (view) {
      view.send(event)
    }
  }

  setViewBackgroundListening(viewIdx: number, listening: boolean) {
    this.sendViewEvent(viewIdx, {
      type: listening ? 'BACKGROUND' : 'UNBACKGROUND',
    })
  }

  setViewBlurred(viewIdx: number, blurred: boolean) {
    this.sendViewEvent(viewIdx, { type: blurred ? 'BLUR' : 'UNBLUR' })
  }

  setViewVolume(viewIdx: number, volume: number) {
    this.sendViewEvent(viewIdx, { type: 'SET_VOLUME', volume })
  }

  reloadView(viewIdx: number) {
    this.sendViewEvent(viewIdx, { type: 'RELOAD' })
  }

  openDevTools(viewIdx: number, inWebContents: WebContents) {
    this.sendViewEvent(viewIdx, { type: 'DEVTOOLS', inWebContents })
  }

  onState(state: StreamwallState) {
    this.overlayView.webContents.send('state', state)
    this.backgroundView.webContents.send('state', state)

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
