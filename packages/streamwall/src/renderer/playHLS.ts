import Hls, { ErrorTypes, Events, type ErrorData } from 'hls.js'
import type { StreamwallMediaGlobal } from '../preload/mediaPreload'

declare global {
  interface Window {
    // Exposed by mediaPreload.ts, this page's preload. Optional because the
    // page can be rendered without the bridge (e.g. in unit tests).
    streamwallMedia?: StreamwallMediaGlobal
  }
}

// hls.js recommends bounding automatic recovery attempts: a stream that
// keeps producing fatal errors after repeated retries is not going to
// recover, and retrying forever would spin silently instead of letting the
// existing view-stall/error detection in mediaPreload.ts take over.
const MAX_FATAL_ERROR_RETRIES = 3

// Matches this page's own `media-src` CSP directive (see playHLS.html).
// `src` is an attacker-controllable query param, so every function that
// feeds it to the network or assigns it to the DOM re-checks this pattern
// immediately beforehand, guarding that sink directly.
const ALLOWED_SRC_PATTERN = /^(https?:|blob:)/i

function loadWithHlsJs(src: string) {
  if (!ALLOWED_SRC_PATTERN.test(src)) return

  const videoEl = document.createElement('video')
  const hls = new Hls()
  let fatalErrorRetries = 0
  let destroyed = false

  const teardown = () => {
    if (destroyed) return
    destroyed = true
    hls.destroy()
  }

  hls.attachMedia(videoEl)
  hls.loadSource(src)

  hls.on(Events.MANIFEST_PARSED, () => {
    document.body.appendChild(videoEl)
  })

  hls.on(Events.ERROR, (_event, data: ErrorData) => {
    if (!data.fatal || destroyed) return

    if (fatalErrorRetries < MAX_FATAL_ERROR_RETRIES) {
      fatalErrorRetries += 1
      if (data.type === ErrorTypes.NETWORK_ERROR) {
        hls.startLoad()
        return
      }
      if (data.type === ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError()
        return
      }
    }

    // Unrecoverable, or the retry budget is exhausted: tear down. Detaching
    // media empties the <video> element, which mediaPreload.ts already
    // observes (its 'emptied' listener / view-loaded timeout) to report the
    // failure to the view state machine.
    teardown()
  })

  window.addEventListener('pagehide', teardown, { once: true })
}

function loadNatively(videoEl: HTMLVideoElement, src: string) {
  if (!ALLOWED_SRC_PATTERN.test(src)) return

  videoEl.addEventListener('loadedmetadata', () => {
    document.body.appendChild(videoEl)
  })
  videoEl.src = src
}

function loadHLS(src: string) {
  // A rejected src never reaches a playback path (the sink guards in
  // loadWithHlsJs/loadNatively would drop it), so report it here rather than
  // letting the tile sit black until the load timeout.
  if (!ALLOWED_SRC_PATTERN.test(src)) {
    window.streamwallMedia?.reportError('src-rejected')
    return
  }

  if (Hls.isSupported()) {
    loadWithHlsJs(src)
    return
  }

  const videoEl = document.createElement('video')
  if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
    loadNatively(videoEl, src)
    return
  }

  // Neither hls.js nor native HLS is available: no <video> will ever be
  // created, so surface the specific cause immediately.
  window.streamwallMedia?.reportError('hls-unsupported')
}

const searchParams = new URLSearchParams(location.search)
const src = searchParams.get('src')
if (src) {
  loadHLS(src)
}
