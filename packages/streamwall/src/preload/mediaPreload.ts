import { contextBridge, ipcRenderer, webFrame } from 'electron'
import { throttle } from 'lodash-es'
import { ContentDisplayOptions } from 'streamwall-shared'
import { MEDIA_PAUSE_EVENT, MEDIA_RESUME_EVENT } from './mediaParkEvents'
import { VolumeController } from './volumeController'

const SCAN_THROTTLE = 500
const INITIAL_TIMEOUT = 10 * 1000

const VIDEO_OVERRIDE_STYLE = `
  * {
    pointer-events: none;
    display: none !important;
    position: static !important;
    z-index: 0 !important;
  }
  html, body, video, audio {
    display: block !important;
    background: black !important;
  }
  html, body {
    overflow: hidden !important;
    background: black !important;
  }
  video, iframe.__video__, audio {
    display: block !important;
    position: fixed !important;
    left: 0 !important;
    right: 0 !important;
    top: 0 !important;
    bottom: 0 !important;
    width: 100vw !important;
    height: 100vh !important;
    object-fit: cover !important;
    transition: none !important;
    z-index: 999999 !important;
  }
  audio {
    z-index: 999998 !important;
  }
  .__video_parent__ {
    display: block !important;
  }
  video.__rot180__ {
    transform: rotate(180deg) !important;
  }
  /* For 90 degree rotations, we position the video with swapped width and height and rotate it into place.
     It's helpful to offset the video so the transformation is centered in the viewport center.
     We move the video top left corner to center of the page and then translate half the video dimensions up and left.
     Note that the width and height are swapped in the translate because the video starts with the side dimensions swapped. */
  video.__rot90__ {
    transform: translate(-50vh, -50vw) rotate(90deg) !important;
  }
  video.__rot270__ {
    transform: translate(-50vh, -50vw) rotate(270deg) !important;
  }
  video.__rot90__, video.__rot270__ {
    left: 50vw !important;
    top: 50vh !important;
    width: 100vh !important;
    height: 100vw !important;
  }
`

const NO_SCROLL_STYLE = `
  html, body {
    overflow: hidden !important;
  }
`

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(() => resolve(), ms))

// Spoof `document.visibilityState`/`document.hidden` as visible so that
// sites which pause playback when backgrounded (checking these properties)
// keep playing inside the offscreen/background WebContentsView. This must
// run via `webFrame.executeJavaScript`, not as a plain assignment against
// this preload script's own `document` reference: with contextIsolation,
// property overrides made in the preload's isolated world are invisible to
// the page's own main-world scripts (see `lockdownMediaTags` below for the
// same reasoning applied to muting). Preload scripts run before the page's
// own scripts on every navigation, so this fires here -- unawaited, since it
// only needs to land before the page's own scripts run and there is nothing
// meaningful to do if it doesn't. Previously this ran from the main process
// against the pre-navigation document, which `loadURL` immediately discards
// (see #25).
webFrame.executeJavaScript(`
  Object.defineProperty(document, 'visibilityState', {
    value: 'visible',
    writable: true
  });
  Object.defineProperty(document, 'hidden', {
    value: false,
    writable: true
  });
`)

const pageReady = new Promise((resolve) =>
  document.addEventListener('DOMContentLoaded', resolve, { once: true }),
)

export class RotationController {
  video: HTMLVideoElement
  siteRotation = 0
  customRotation: number

  constructor(video: HTMLVideoElement) {
    this.video = video
    this.customRotation = 0
  }

  _update() {
    // JS `%` keeps the operand's sign, so normalize negatives into [0, 360)
    // before validating (e.g. -90 -> 270).
    const rotation = ((this.customRotation % 360) + 360) % 360
    if (![0, 90, 180, 270].includes(rotation)) {
      // Only 0/90/180/270 have CSS rules. Ignore anything else and keep the
      // current rotation class rather than replacing it with an inert one.
      console.warn('ignoring invalid rotation', this.customRotation)
      return
    }
    this.video.className = `__rot${rotation}__`
  }

  setCustom(rotation = 0) {
    this.customRotation = rotation
    this._update()
  }
}

// Exported for tests only; not part of the module's public surface.
export class SnapshotController {
  canvas: HTMLCanvasElement
  ctx!: CanvasRenderingContext2D
  latestSnapshotURL: string | null = null

  constructor() {
    this.canvas = document.createElement('canvas')
  }

  async snapshotVideo(videoEl: HTMLVideoElement) {
    if (!('requestVideoFrameCallback' in videoEl)) {
      console.warn('requestVideoFrameCallback not supported')
      return
    }

    videoEl.requestVideoFrameCallback(() => {
      const { canvas } = this
      canvas.width = videoEl.videoWidth
      canvas.height = videoEl.videoHeight

      const ctx = canvas.getContext('2d')
      if (!ctx) {
        console.warn('could not get canvas context')
        return
      }

      ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height)
      canvas.toBlob((blob) => {
        if (!blob) {
          console.warn('could not create blob from canvas')
          return
        }

        // Revoke the previous poster's object URL so its blob can be
        // collected -- without this, each 1s snapshot tick pins another
        // full-resolution PNG in renderer memory for the page's lifetime.
        if (this.latestSnapshotURL) {
          URL.revokeObjectURL(this.latestSnapshotURL)
        }

        const url = URL.createObjectURL(blob)
        this.latestSnapshotURL = url
        videoEl.poster = url
      }, 'image/png')
    })
  }
}

// A throttled scan callback, as returned by lodash's `throttle`.
type ScanCallback = (() => void) & { cancel(): void }

// Every MutationObserver created here is registered so a single teardown can
// disconnect them all. A document is discarded on navigation, but a view can
// search for media repeatedly within one document (see acquireMedia's
// 'emptied' re-acquisition), and an abandoned observer would otherwise keep
// firing its throttled callback for the rest of the page's life -- see #412.
const observerTeardowns = new Set<() => void>()

function observeSubtree(root: Node, scan: ScanCallback): () => void {
  const observer = new MutationObserver(scan)
  observer.observe(root, { subtree: true, childList: true })
  const stop = () => {
    observer.disconnect()
    scan.cancel()
    observerTeardowns.delete(stop)
  }
  observerTeardowns.add(stop)
  return stop
}

function observeBody(scan: ScanCallback): () => void {
  return observeSubtree(document.body, scan)
}

// Nothing in the page world outlives its document, so once it goes away even
// the deliberately long-lived lockdown observer below can stop watching.
window.addEventListener('pagehide', () => {
  for (const stop of [...observerTeardowns]) {
    stop()
  }
})

// Set once the lockdown observer is installed. It watches for the document's
// lifetime by design, so repeated calls must reuse it rather than stack up a
// second observer running the same scan (#412).
let isMediaTagsLockedDown = false

// Watch for media tags and mute them as soon as possible.
async function lockdownMediaTags() {
  if (isMediaTagsLockedDown) {
    return
  }
  isMediaTagsLockedDown = true
  const lockdown = throttle(() => {
    webFrame.executeJavaScript(`
      for (const el of document.querySelectorAll('video, audio')) {
        if (el.__sw) {
          continue
        }
        // Prevent sites from re-muting the video
        Object.defineProperty(el, 'muted', { writable: true, value: false })
        // Prevent Facebook from pausing the video after page load.
        Object.defineProperty(el, 'pause', { writable: false, value: () => {} })
        el.__sw = true
      }
    `)
  }, SCAN_THROTTLE)
  await pageReady
  observeBody(lockdown)
}

// Resolves once `signal` aborts, and never if there is no signal to abort.
const aborted = (signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (!signal) {
      return
    }
    if (signal.aborted) {
      resolve()
      return
    }
    signal.addEventListener('abort', () => resolve(), { once: true })
  })

// Resolves with the first element matching `query`, or with `undefined` if
// `signal` aborts first. Callers that give up on a search (timeout, or a
// sibling search winning a race) must abort it: without that, the search's
// observer would stay connected forever, since its promise can only settle by
// finding the element (#412).
async function waitForQuery(
  query: string,
  signal?: AbortSignal,
): Promise<Element | undefined> {
  console.log(`waiting for '${query}'...`)
  // The abort has to cut this wait short too, not just the observing below:
  // a page that never reaches DOMContentLoaded (a stalled or dead stream
  // page) would otherwise leave the caller's timeout with nothing to settle.
  await Promise.race([pageReady, aborted(signal)])
  if (signal?.aborted) {
    return undefined
  }
  return new Promise((resolve) => {
    const scan = throttle(() => {
      const el = document.querySelector(query)
      if (el) {
        console.log(`found '${query}'`)
        stop()
        resolve(el)
      }
    }, SCAN_THROTTLE)

    const stop = observeBody(scan)
    signal?.addEventListener(
      'abort',
      () => {
        stop()
        resolve(undefined)
      },
      { once: true },
    )
    scan()
  })
}

type MediaSearchResult = {
  video?: HTMLMediaElement
  iframe?: HTMLIFrameElement
  iframeDocument?: Document
  crossOriginIframe?: boolean
}

// One pass over the top-level document and every iframe embedded in it.
//
// Some pages embed their player in an iframe. Its document is only reachable
// when it is same-origin: a cross-origin frame has an opaque origin, so
// `contentDocument` reads as null and no amount of waiting will ever make the
// <video> inside visible from here. Report that case so findMedia can name it
// instead of reporting a generic missing video.
function scanForMedia(kind: 'video' | 'audio'): MediaSearchResult {
  const video = document.querySelector(kind)
  if (video instanceof HTMLMediaElement) {
    return { video }
  }

  let crossOriginIframe = false
  for (const iframe of document.querySelectorAll('iframe')) {
    const iframeDocument = iframe.contentDocument
    if (!iframeDocument) {
      crossOriginIframe = true
      continue
    }
    const framedVideo = iframeDocument.querySelector(kind)
    if (framedVideo instanceof HTMLMediaElement) {
      return { video: framedVideo, iframe, iframeDocument }
    }
  }
  return { crossOriginIframe }
}

// Resolves with the first media element found in the document or in any
// same-origin iframe, or with the last scan's outcome if `signal` aborts
// first. Both places are covered by the same retry loop: scanning iframes
// only once, after the top-level wait had run out, meant a frame inserted (or
// filled) later was never re-examined, and an unbounded search -- which never
// times out -- never scanned them at all (#485).
async function waitForMedia(
  kind: 'video' | 'audio',
  signal: AbortSignal,
): Promise<MediaSearchResult> {
  console.log(`waiting for '${kind}'...`)
  // The abort has to cut this wait short too, not just the observing below:
  // a page that never reaches DOMContentLoaded (a stalled or dead stream
  // page) would otherwise leave the caller's timeout with nothing to settle.
  await Promise.race([pageReady, aborted(signal)])
  if (signal.aborted) {
    return {}
  }
  return new Promise((resolve) => {
    // Iframes already wired for their own 'load' event. A frame's document is
    // outside the tree observed below, so mutations in the embedder never
    // report the moment a frame finishes loading the player it contains.
    const watchedIframes = new Set<HTMLIFrameElement>()
    const rescan = () => scan()

    // Observers watching the documents of reachable frames, keyed by frame.
    // A same-origin frame may insert its player from its own scripts long
    // after it finished loading (a player bootstrapped in-frame, a consent
    // gate resolved, an ad pre-roll swapped out): that mutation happens in a
    // tree the embedder's observer does not cover, and no further 'load'
    // event announces it either -- so watch each frame's document as well
    // (#534). The observed body is kept so a navigation, which replaces the
    // frame's document, re-attaches rather than leaving a stale observer.
    const frameObservers = new Map<
      HTMLIFrameElement,
      { body: HTMLElement; stop: () => void }
    >()
    const observeFrameDocument = (iframe: HTMLIFrameElement) => {
      const body = iframe.contentDocument?.body
      const observed = frameObservers.get(iframe)
      if (observed?.body === body) {
        return
      }
      observed?.stop()
      if (!body) {
        // Cross-origin, or a document that has no body (yet).
        frameObservers.delete(iframe)
        return
      }
      frameObservers.set(iframe, { body, stop: observeSubtree(body, scan) })
    }

    const scan = throttle(() => {
      const result = scanForMedia(kind)
      for (const iframe of document.querySelectorAll('iframe')) {
        if (!watchedIframes.has(iframe)) {
          watchedIframes.add(iframe)
          iframe.addEventListener('load', rescan)
        }
        observeFrameDocument(iframe)
      }
      if (result.video) {
        console.log(`found '${kind}'`)
        stop()
        resolve(result)
      }
    }, SCAN_THROTTLE)

    const stopObserving = observeBody(scan)
    const stop = () => {
      for (const iframe of watchedIframes) {
        iframe.removeEventListener('load', rescan)
      }
      watchedIframes.clear()
      for (const { stop: stopFrameObserver } of frameObservers.values()) {
        stopFrameObserver()
      }
      frameObservers.clear()
      stopObserving()
    }

    signal.addEventListener(
      'abort',
      () => {
        stop()
        // The teardown just cancelled whatever trailing scan the throttle was
        // holding, so take one final look before giving up -- and report the
        // freshest cross-origin verdict rather than an early scan's.
        resolve(scanForMedia(kind))
      },
      { once: true },
    )
    scan()
  })
}

async function waitForVideo(
  kind: 'video' | 'audio',
  timeoutMs = INITIAL_TIMEOUT,
): Promise<MediaSearchResult> {
  lockdownMediaTags()

  // One search, bounded by its own abort timer. Racing a search against a
  // sleep instead would both start a second, immediately orphaned search and
  // leave the losing search observing the document forever (#412).
  const search = new AbortController()
  const searchTimeout =
    timeoutMs === Infinity
      ? undefined
      : setTimeout(() => search.abort(), timeoutMs)
  try {
    return await waitForMedia(kind, search.signal)
  } finally {
    clearTimeout(searchTimeout)
  }
}

const igHacks = {
  isMatch() {
    return location.host === 'www.instagram.com'
  },
  async onLoad() {
    // Both searches share one abort: whichever settles the race first (a
    // match or the timer), the other's observer is disconnected rather than
    // left watching the document for the rest of the page's life (#412).
    const search = new AbortController()
    const searchTimeout = setTimeout(() => search.abort(), 1000)
    const playButton = await Promise.race([
      waitForQuery('button', search.signal),
      waitForQuery('video', search.signal),
    ])
    clearTimeout(searchTimeout)
    search.abort()
    if (
      playButton instanceof HTMLButtonElement &&
      playButton.tagName === 'BUTTON' &&
      playButton.textContent === 'Tap to play'
    ) {
      playButton.click()
    }
  },
}

async function findMedia(
  kind: 'video' | 'audio',
  elementTimeout = INITIAL_TIMEOUT,
) {
  if (igHacks.isMatch()) {
    await igHacks.onLoad()
  }

  const { video, iframe, iframeDocument, crossOriginIframe } =
    await waitForVideo(kind, elementTimeout)
  if (!video) {
    // A cross-origin iframe is a hard limitation rather than a slow page, and
    // an operator seeing only "could not find video" cannot tell the two
    // apart (issue #413).
    throw new Error(
      crossOriginIframe
        ? 'could not find video: it may be inside a cross-origin iframe, which is unsupported'
        : 'could not find video',
    )
  }
  if (iframe && iframeDocument) {
    // The page's own styles live in the iframe document, so the override has
    // to be injected there as well; the iframe itself and every ancestor are
    // marked so VIDEO_OVERRIDE_STYLE's `display: none` blanket doesn't hide
    // the chain leading to the video.
    const style = iframeDocument.createElement('style')
    style.innerHTML = VIDEO_OVERRIDE_STYLE
    iframeDocument.head.appendChild(style)
    iframe.className = '__video__'
    let parentEl = iframe.parentElement
    while (parentEl) {
      parentEl.className = '__video_parent__'
      parentEl = parentEl.parentElement
    }
    iframeDocument.body.appendChild(video)
  } else {
    document.body.appendChild(video)
  }

  // Fire-and-forget: playback readiness is confirmed below via videoWidth, so
  // the play() promise is not awaited. A rejection (autoplay policy, or a load
  // interrupted by a superseding acquisition) is otherwise invisible, so log it
  // as a breadcrumb, symmetric with the resume path (issue #392/#626).
  video.play().catch((err) => {
    console.warn('error starting media playback', err)
  })

  if (video instanceof HTMLVideoElement && !video.videoWidth) {
    console.log(`video isn't playing yet. waiting for it to start...`)
    let videoReady: Promise<unknown> = new Promise((resolve) =>
      video.addEventListener('playing', resolve, { once: true }),
    )
    if (elementTimeout !== Infinity) {
      videoReady = Promise.race([videoReady, sleep(elementTimeout)])
    }
    await videoReady
    if (!video.videoWidth) {
      throw new Error('timeout waiting for video to start')
    }
    console.log('video started')
  }

  video.muted = false

  return video
}

// The locally-bundled HLS player page (renderer/playHLS.ts) loads under this
// preload but, being page script under contextIsolation, has no direct
// ipcRenderer access. When it decides up front that a stream can never play --
// the engine supports neither hls.js nor native HLS, or a src is rejected by
// its scheme allowlist -- it never creates a <video>, so findMedia() above sits
// until the state machine's much longer load timeout fires a generic error.
// Expose a minimal channel so the page can surface the specific cause at once.
//
// The reason is looked up in a closed vocabulary and only the mapped, fixed
// message is ever sent -- never free-form text from the page. This preload is
// also attached to untrusted remote stream views, so the strict mapping ensures
// the worst a page can do here is put its own tile into an error state it could
// already reach by simply failing to play.
const MEDIA_ERROR_MESSAGES: Record<string, string> = {
  'hls-unsupported': 'HLS playback is not supported',
  'src-rejected': 'Stream source rejected (disallowed URL scheme)',
}

// Guards against reporting more than one view-error per preload load: the
// playHLS reportError() channel and findMedia's own timeout race each other
// for the same view, and only the first (more specific, where applicable)
// cause should reach the operator.
let hasReportedMediaError = false

const mediaApi = {
  reportError(reason: string) {
    const message = MEDIA_ERROR_MESSAGES[reason]
    if (message === undefined || hasReportedMediaError) {
      return
    }
    hasReportedMediaError = true
    ipcRenderer.send('view-error', { error: message })
  },
}

export type StreamwallMediaGlobal = typeof mediaApi

contextBridge.exposeInMainWorld('streamwallMedia', mediaApi)

async function main() {
  const viewInit = ipcRenderer.invoke('view-init')
  const pageReady = new Promise((resolve) => process.once('loaded', resolve))

  const [{ content, options: initialOptions, volume: initialVolume }] =
    await Promise.all([viewInit, pageReady])

  const snapshotController = new SnapshotController()

  let rotationController: RotationController | undefined
  let volumeController: VolumeController | undefined
  let latestVolume = initialVolume ?? 1
  // The most recently acquired media element (reassigned across a re-
  // acquisition, e.g. the 'emptied' handler below), so a PAUSE/RESUME
  // message received at any point can act on whichever one is current.
  let currentMedia: HTMLMediaElement | undefined
  async function acquireMedia(elementTimeout: number) {
    let snapshotInterval: number | undefined

    const media = await findMedia(content.kind, elementTimeout)
    console.log('media acquired', media)

    currentMedia = media
    volumeController = new VolumeController(media, latestVolume)
    ipcRenderer.send('view-loaded')

    if (content.kind === 'video' && media instanceof HTMLVideoElement) {
      rotationController = new RotationController(media)
      snapshotInterval = window.setInterval(() => {
        snapshotController.snapshotVideo(media)
      }, 1000)
    }

    media.addEventListener(
      'emptied',
      async () => {
        console.warn('media emptied, re-acquiring', media)

        ipcRenderer.send('view-stalled')
        clearInterval(snapshotInterval)

        // Unlike main()'s own top-level acquireMedia() call, this one is
        // awaited within the handler itself, so a plain .catch() chained
        // onto it wouldn't help: EventTarget.addEventListener discards
        // whatever an async listener returns, so a rejection here becomes
        // an unhandled rejection on the listener's own detached promise
        // unless it's caught in place -- see #316 (same root cause as #309).
        try {
          const newMedia = await acquireMedia(Infinity)
          if (newMedia !== media) {
            media.remove()
          }
        } catch (error) {
          if (hasReportedMediaError) {
            return
          }
          hasReportedMediaError = true
          ipcRenderer.send('view-error', { error })
        }
      },
      { once: true },
    )
    return media
  }

  if (content.kind === 'video' || content.kind === 'audio') {
    webFrame.insertCSS(VIDEO_OVERRIDE_STYLE, { cssOrigin: 'user' })
    // Unlike the re-acquisition triggered by the 'emptied' listener inside
    // acquireMedia (which is awaited within that async handler), this first
    // call is fire-and-forget from main()'s perspective, so its rejection
    // must be caught here or it becomes an unhandled rejection and
    // findMedia's specific reason (e.g. "could not find video") never
    // reaches the operator -- see #309.
    acquireMedia(INITIAL_TIMEOUT).catch((error) => {
      if (hasReportedMediaError) {
        return
      }
      hasReportedMediaError = true
      ipcRenderer.send('view-error', { error })
    })
    ipcRenderer.send('view-info', {
      info: {
        title: document.title,
      },
    })
  } else if (content.kind === 'web') {
    webFrame.insertCSS(NO_SCROLL_STYLE, { cssOrigin: 'user' })
    ipcRenderer.send('view-loaded')
  }

  function updateOptions(options: ContentDisplayOptions) {
    if (rotationController) {
      rotationController.setCustom(options.rotation)
    }
  }
  ipcRenderer.on('options', (ev, options) => updateOptions(options))
  updateOptions(initialOptions)

  function updateVolume(volume: number) {
    latestVolume = volume
    volumeController?.setVolume(volume)
  }
  ipcRenderer.on('volume', (ev, volume) => updateVolume(volume))

  // Stops/resumes the acquired media element's own playback -- used to pause
  // a parked (hidden) view instead of keeping it fully live while it's
  // hidden behind a fullscreen expansion (issue #374). No-ops when no media
  // has been acquired yet (e.g. a 'web' kind view, or one still loading).
  ipcRenderer.on('pause', () => {
    // Announced unconditionally, before the media guard below: the bundled
    // HLS player page keeps its hls.js instance in a closure this preload
    // cannot reach, and it should stop fetching segments whether or not a
    // <video> has been acquired here yet (issue #384).
    document.dispatchEvent(new CustomEvent(MEDIA_PAUSE_EVENT))
    if (!currentMedia) {
      return
    }
    // lockdownMediaTags() permanently shadows the element's own `pause`
    // method with a no-op (to stop sites like Facebook from auto-pausing),
    // so call the native implementation directly instead of
    // `currentMedia.pause()`, which would silently do nothing.
    HTMLMediaElement.prototype.pause.call(currentMedia)
  })
  ipcRenderer.on('resume', () => {
    document.dispatchEvent(new CustomEvent(MEDIA_RESUME_EVENT))
    // Live streams are typically not seekable on-demand video, so resuming
    // after a pause may briefly re-buffer or land slightly behind the live
    // edge -- both cheaper than a full reload and expected to self-correct
    // as playback continues. A play() rejection (e.g. autoplay policy) is
    // otherwise invisible, so log it as a breadcrumb (issue #392).
    currentMedia?.play().catch((err) => {
      console.warn('error resuming media playback', err)
    })
  })
}

main().catch((error) => {
  ipcRenderer.send('view-error', { error })
})
