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

  constructor(
    config: StreamWindowConfig,
    retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG,
  ) {
    super()
    this.config = config
    this.retryConfig = retryConfig
    this.views = new Map()

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

    ipcMain.handle('view-init', async (ev) => {
      const view = this.views.get(ev.sender.id)
      if (view) {
        view.send({ type: 'VIEW_INIT' })
        const { content, options, volume } = view.getSnapshot().context
        return {
          content,
          options,
          volume,
        }
      }
    })
    ipcMain.on('view-loaded', (ev) => {
      this.views.get(ev.sender.id)?.send?.({ type: 'VIEW_LOADED' })
    })
    ipcMain.on('view-stalled', (ev) => {
      this.views.get(ev.sender.id)?.send?.({ type: 'VIEW_STALLED' })
    })
    ipcMain.on('view-info', (ev, { info }) => {
      this.views.get(ev.sender.id)?.send?.({ type: 'VIEW_INFO', info })
    })
    ipcMain.on('view-error', (ev, { error }) => {
      this.views.get(ev.sender.id)?.send?.({ type: 'VIEW_ERROR', error })
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

  createView() {
    const {
      win,
      config: { width, height },
    } = this
    assert(win != null, 'Window must be initialized')
    const { backgroundColor } = this.config
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

    const viewId = view.webContents.id

    // Lock the view to its stream URL: deny popups and block navigation/redirect
    // escapes while still allowing the page to reload itself.
    secureStreamView(view.webContents)

    // Hidden window used for loading the BrowserView before it's positioned in the wall
    const offscreenWin = new BrowserWindow({
      width,
      height,
      show: false,
    })

    const actor = createActor(viewStateMachine, {
      input: {
        id: viewId,
        view,
        win,
        offscreenWin,
        retry: this.retryConfig,
      },
    })

    let lastSnapshot: SnapshotFrom<typeof viewStateMachine> | undefined
    actor.subscribe((snapshot) => {
      if (snapshot === lastSnapshot) {
        return
      }
      lastSnapshot = snapshot
      this.emitState()
    })

    actor.start()

    // Surface main-frame load failures (e.g. ERR_NAME_NOT_RESOLVED) as view
    // errors so the state machine leaves the loading state instead of hanging.
    // loadPage intentionally does not await loadURL — awaiting would delay the
    // navigate->waitForInit transition past the preload's early VIEW_INIT and
    // hang every view — so failures are reported here instead.
    view.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
        // -3 is ERR_ABORTED: superseded navigation or self-reload, not a failure.
        if (isMainFrame && errorCode !== -3) {
          actor.send({
            type: 'VIEW_ERROR',
            error: new Error(
              `Failed to load (${errorCode}): ${errorDescription}`,
            ),
          })
        }
      },
    )

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

  setViews(viewContentMap: ViewContentMap, streams: StreamList) {
    const { width, height, cols, rows } = this.config
    const spaceWidth = Math.floor(width / cols)
    const spaceHeight = Math.floor(height / rows)
    const { win, views } = this
    const boxes = boxesFromViewContentMap(cols, rows, viewContentMap)
    const remainingBoxes = new Set(boxes)
    const unusedViews = new Set(views.values())
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
      const { content, x, y, w, h, spaces } = box
      if (!content) {
        continue
      }

      const stream = streams.byURL?.get(content.url)
      if (!stream) {
        continue
      }

      const pos = {
        x: spaceWidth * x,
        y: spaceHeight * y,
        width: spaceWidth * w,
        height: spaceHeight * h,
        spaces,
      }

      view.send({ type: 'DISPLAY', pos, content })
      view.send({ type: 'OPTIONS', options: getDisplayOptions(stream) })
      newViews.set(view.getSnapshot().context.id, view)
    }
    for (const view of unusedViews) {
      view.stop()
      const { view: contentView, offscreenWin } = view.getSnapshot().context
      offscreenWin.contentView.removeChildView(contentView)
      win.contentView.removeChildView(contentView)
      contentView.webContents.close()
      offscreenWin.destroy()
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
