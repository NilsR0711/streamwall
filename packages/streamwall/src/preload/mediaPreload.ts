import { contextBridge, ipcRenderer, webFrame } from 'electron'
import throttle from 'lodash/throttle'
import { ContentDisplayOptions } from 'streamwall-shared'
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

class RotationController {
  video: HTMLVideoElement
  siteRotation = 0
  customRotation: number

  constructor(video: HTMLVideoElement) {
    this.video = video
    this.customRotation = 0
  }

  _update() {
    const rotation = this.customRotation % 360
    if (![0, 90, 180, 270].includes(rotation)) {
      console.warn('ignoring invalid rotation', rotation)
    }
    this.video.className = `__rot${rotation}__`
  }

  setCustom(rotation = 0) {
    this.customRotation = rotation
    this._update()
  }
}

class SnapshotController {
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

        if (this.latestSnapshotURL) {
          URL.revokeObjectURL(this.latestSnapshotURL)
        }

        const url = URL.createObjectURL(blob)
        videoEl.poster = url
      }, 'image/png')
    })
  }
}

// Watch for media tags and mute them as soon as possible.
async function lockdownMediaTags() {
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
  const observer = new MutationObserver(lockdown)
  observer.observe(document.body, { subtree: true, childList: true })
}

async function waitForQuery(query: string): Promise<Element> {
  console.log(`waiting for '${query}'...`)
  await pageReady
  return new Promise((resolve) => {
    const scan = throttle(() => {
      const el = document.querySelector(query)
      if (el) {
        console.log(`found '${query}'`)
        resolve(el)
        observer.disconnect()
      }
    }, SCAN_THROTTLE)

    const observer = new MutationObserver(scan)
    observer.observe(document.body, { subtree: true, childList: true })
    scan()
  })
}

async function waitForVideo(
  kind: 'video' | 'audio',
  timeoutMs = INITIAL_TIMEOUT,
): Promise<{
  video?: HTMLMediaElement
  iframe?: HTMLIFrameElement
}> {
  lockdownMediaTags()

  let queryPromise: Promise<Element | void> = waitForQuery(kind)
  if (timeoutMs !== Infinity) {
    queryPromise = Promise.race([waitForQuery(kind), sleep(timeoutMs)])
  }
  let video: Element | null | void = await queryPromise
  if (video instanceof HTMLMediaElement) {
    return { video }
  }

  let iframe
  for (iframe of document.querySelectorAll('iframe')) {
    video = iframe.contentDocument?.querySelector?.(kind)
    if (video instanceof HTMLVideoElement) {
      return { video, iframe }
    }
  }
  return {}
}

const igHacks = {
  isMatch() {
    return location.host === 'www.instagram.com'
  },
  async onLoad() {
    const playButton = await Promise.race([
      waitForQuery('button'),
      waitForQuery('video'),
      sleep(1000),
    ])
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

  const { video, iframe } = await waitForVideo(kind, elementTimeout)
  if (!video) {
    throw new Error('could not find video')
  }
  if (iframe && iframe.contentDocument) {
    // TODO: verify iframe still works
    const style = iframe.contentDocument.createElement('style')
    style.innerHTML = VIDEO_OVERRIDE_STYLE
    iframe.contentDocument.head.appendChild(style)
    iframe.className = '__video__'
    let parentEl = iframe.parentElement
    while (parentEl) {
      parentEl.className = '__video_parent__'
      parentEl = parentEl.parentElement
    }
    iframe.contentDocument.body.appendChild(video)
  } else {
    document.body.appendChild(video)
  }

  video.play()

  if (video instanceof HTMLVideoElement && !video.videoWidth) {
    console.log(`video isn't playing yet. waiting for it to start...`)
    const videoReady = new Promise((resolve) =>
      video.addEventListener('playing', resolve, { once: true }),
    )
    await Promise.race([videoReady, sleep(INITIAL_TIMEOUT)])
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
  async function acquireMedia(elementTimeout: number) {
    let snapshotInterval: number | undefined

    const media = await findMedia(content.kind, elementTimeout)
    console.log('media acquired', media)

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

        const newMedia = await acquireMedia(Infinity)
        if (newMedia !== media) {
          media.remove()
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
}

main().catch((error) => {
  ipcRenderer.send('view-error', { error })
})
