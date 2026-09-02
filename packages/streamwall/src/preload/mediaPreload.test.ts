// @vitest-environment happy-dom
import { MAX_VIEW_INFO_TITLE_LENGTH } from 'streamwall-shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const executeJavaScript = vi.fn()
// Never resolves, so the assertions below can prove the visibility spoof
// does not wait on the view-init round trip before running.
const invoke = vi.fn(() => new Promise(() => {}))
const send = vi.fn()
const on = vi.fn()
const exposeInMainWorld = vi.fn()

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke, send, on },
  webFrame: { executeJavaScript, insertCSS: vi.fn() },
}))

type MediaApi = { reportError: (reason: string) => void }

function importedMediaApi(): MediaApi {
  const call = exposeInMainWorld.mock.calls.find(
    ([name]) => name === 'streamwallMedia',
  )
  if (!call) throw new Error('streamwallMedia was not exposed')
  return call[1] as MediaApi
}

// Looks up the handler a describe block's own import registered for
// `channel`. Every describe here clears the `on` mock in its own afterEach
// before the next one imports the module (see the comment on the
// 'RotationController' describe below), so at most one registration per
// channel is ever live when a test calls this -- it takes the first match
// rather than the last purely to preserve that existing contract.
function registeredHandler(channel: string): (...args: unknown[]) => void {
  const call = on.mock.calls.find(([ch]) => ch === channel)
  if (!call) {
    throw new Error(`no ipcRenderer.on('${channel}', ...) handler registered`)
  }
  return call[1] as (...args: unknown[]) => void
}

function viewLoadedCalls() {
  return send.mock.calls.filter(([channel]) => channel === 'view-loaded')
}

function viewErrorCalls() {
  return send.mock.calls.filter(([channel]) => channel === 'view-error')
}

// happy-dom's HTMLVideoElement never implements videoWidth, so give it a
// truthy value to skip findMedia's "wait for playing" branch on acquisition.
// Pass `doc` for an iframe's own document (defaults to the top-level
// `document`); pass `append: true` to attach the element under `doc.body`
// immediately, for tests that need it already in the DOM before importing
// the module.
function playableVideo({
  doc = document,
  append = false,
}: { doc?: Document; append?: boolean } = {}): HTMLVideoElement {
  const video = doc.createElement('video')
  ;(video as unknown as { videoWidth: number }).videoWidth = 100
  if (append) {
    doc.body.appendChild(video)
  }
  return video
}

describe('mediaPreload visibility spoofing', () => {
  afterEach(() => {
    vi.resetModules()
    executeJavaScript.mockClear()
    invoke.mockClear()
    send.mockClear()
    on.mockClear()
    exposeInMainWorld.mockClear()
  })

  it('overrides document.visibilityState/hidden in the page world as soon as the preload script runs', async () => {
    await import('./mediaPreload')

    expect(executeJavaScript).toHaveBeenCalledTimes(1)
    const [code] = executeJavaScript.mock.calls[0]
    expect(code).toContain(`'visibilityState'`)
    expect(code).toContain(`value: 'visible'`)
    expect(code).toContain(`'hidden'`)
    expect(code).toContain('value: false')

    // main() is still awaiting the never-resolving view-init invoke, proving
    // the spoof isn't gated on it -- it must apply before the page's own
    // scripts run, not after this preload script finishes its own setup.
    expect(invoke).toHaveBeenCalledWith('view-init')
  })
})

describe('mediaPreload error channel', () => {
  afterEach(() => {
    vi.resetModules()
    send.mockClear()
    on.mockClear()
    exposeInMainWorld.mockClear()
  })

  it('exposes a streamwallMedia bridge to the page world', async () => {
    await import('./mediaPreload')

    expect(exposeInMainWorld).toHaveBeenCalledWith(
      'streamwallMedia',
      expect.objectContaining({ reportError: expect.any(Function) }),
    )
  })

  it('maps a known reason to a fixed message and sends it as a view-error', async () => {
    await import('./mediaPreload')

    importedMediaApi().reportError('hls-unsupported')

    expect(send).toHaveBeenCalledWith('view-error', {
      error: 'HLS playback is not supported',
    })
  })

  it('maps the src-rejected reason to its own fixed message', async () => {
    await import('./mediaPreload')

    importedMediaApi().reportError('src-rejected')

    expect(send).toHaveBeenCalledWith('view-error', {
      error: 'Stream source rejected (disallowed URL scheme)',
    })
  })

  it('ignores an unknown reason so an untrusted page cannot inject arbitrary error text', async () => {
    await import('./mediaPreload')

    importedMediaApi().reportError('<img src=x onerror=alert(1)>')

    expect(send).not.toHaveBeenCalledWith('view-error', expect.anything())
  })
})

describe('mediaPreload initial acquireMedia rejection', () => {
  // Must match INITIAL_TIMEOUT in mediaPreload.ts; not exported since it's an
  // implementation detail, not part of the module's public surface.
  const INITIAL_TIMEOUT_MS = 10 * 1000

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.resetModules()
    invoke.mockClear()
    send.mockClear()
    on.mockClear()
    exposeInMainWorld.mockClear()
  })

  // Resolves view-init with 'video' content (so main() reaches the
  // acquireMedia() call) and fires process's 'loaded' event (so main()'s own
  // pageReady wait resolves). The module-scope DOMContentLoaded-gated
  // pageReady used by waitForQuery is deliberately left unresolved, so no
  // <video> element is ever "found" and the INITIAL_TIMEOUT sleep always
  // wins the race in findMedia().
  async function loadWithVideoContent() {
    invoke.mockResolvedValueOnce({
      content: { kind: 'video', link: 'https://example.com/stream' },
      options: {},
      volume: 1,
    })
    await import('./mediaPreload')
    process.emit('loaded' as never)
    await vi.advanceTimersByTimeAsync(0)
  }

  it("reports findMedia's specific timeout instead of leaving it an unhandled rejection", async () => {
    await loadWithVideoContent()

    await vi.advanceTimersByTimeAsync(INITIAL_TIMEOUT_MS)

    expect(viewErrorCalls()).toEqual([
      [
        'view-error',
        { error: expect.objectContaining({ message: 'could not find video' }) },
      ],
    ])
  })

  it('does not let a late generic timeout override an already-reported playHLS error', async () => {
    await loadWithVideoContent()

    importedMediaApi().reportError('hls-unsupported')
    expect(viewErrorCalls()).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(INITIAL_TIMEOUT_MS)

    expect(viewErrorCalls()).toHaveLength(1)
  })

  it('does not let a late playHLS report override an already-reported generic timeout', async () => {
    await loadWithVideoContent()

    await vi.advanceTimersByTimeAsync(INITIAL_TIMEOUT_MS)
    expect(viewErrorCalls()).toHaveLength(1)

    importedMediaApi().reportError('hls-unsupported')

    expect(viewErrorCalls()).toHaveLength(1)
  })
})

describe('mediaPreload view-info title bound (issue #734)', () => {
  // Must match INITIAL_TIMEOUT in mediaPreload.ts; not exported since it's an
  // implementation detail, not part of the module's public surface.
  const INITIAL_TIMEOUT_MS = 10 * 1000

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.resetModules()
    invoke.mockClear()
    send.mockClear()
    on.mockClear()
    exposeInMainWorld.mockClear()
  })

  function viewInfoCalls() {
    return send.mock.calls.filter(([channel]) => channel === 'view-info')
  }

  // Resolves view-init with 'video' content, which is what makes main() send
  // the view-info message containing document.title. Since no <video>
  // element is ever placed in the document and DOMContentLoaded is never
  // dispatched, findMedia's own search stays pending until its INITIAL_TIMEOUT
  // elapses; fully advancing past that here (as the sibling "initial
  // acquireMedia rejection" describe block above does) settles it and
  // releases its MutationObserver, rather than leaving it dangling on the
  // shared happy-dom `document` to affect a later, unrelated test.
  async function loadWithVideoContent() {
    invoke.mockResolvedValueOnce({
      content: { kind: 'video', link: 'https://example.com/stream' },
      options: {},
      volume: 1,
    })
    await import('./mediaPreload')
    process.emit('loaded' as never)
    await vi.advanceTimersByTimeAsync(0)
  }

  async function settleAcquireMedia() {
    await vi.advanceTimersByTimeAsync(INITIAL_TIMEOUT_MS)
  }

  it('truncates a page-controlled document.title before sending it as view-info', async () => {
    document.title = 'x'.repeat(MAX_VIEW_INFO_TITLE_LENGTH + 300)

    await loadWithVideoContent()

    expect(viewInfoCalls()).toEqual([
      [
        'view-info',
        { info: { title: 'x'.repeat(MAX_VIEW_INFO_TITLE_LENGTH) } },
      ],
    ])

    await settleAcquireMedia()
  })

  it('leaves a title within the limit untouched', async () => {
    document.title = 'a short stream title'

    await loadWithVideoContent()

    expect(viewInfoCalls()).toEqual([
      ['view-info', { info: { title: 'a short stream title' } }],
    ])

    await settleAcquireMedia()
  })
})

describe("mediaPreload emptied handler's re-acquisition rejection", () => {
  // Must match INITIAL_TIMEOUT in mediaPreload.ts; not exported since it's an
  // implementation detail, not part of the module's public surface.
  const INITIAL_TIMEOUT_MS = 10 * 1000

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.resetModules()
    invoke.mockClear()
    send.mockClear()
    on.mockClear()
    exposeInMainWorld.mockClear()
    document.body.innerHTML = ''
  })

  it("honors the unbounded elementTimeout passed to the emptied handler's re-acquisition instead of always falling back to INITIAL_TIMEOUT", async () => {
    const video = document.createElement('video')
    // happy-dom's HTMLVideoElement never implements videoWidth (always
    // undefined), so give it a truthy value here to skip findMedia's "wait
    // for playing" branch on the initial acquisition and let it resolve
    // immediately once the element is found.
    ;(video as unknown as { videoWidth: number }).videoWidth = 100
    document.body.appendChild(video)

    invoke.mockResolvedValueOnce({
      content: { kind: 'video', link: 'https://example.com/stream' },
      options: {},
      volume: 1,
    })

    await import('./mediaPreload')
    document.dispatchEvent(new Event('DOMContentLoaded'))
    process.emit('loaded' as never)
    await vi.advanceTimersByTimeAsync(0)

    // Confirms the initial acquisition succeeded and attached the 'emptied'
    // listener under test, rather than this test accidentally exercising
    // the initial-acquisition rejection path covered above.
    expect(send).toHaveBeenCalledWith('view-loaded')

    // A real emptied element resets its own readiness; re-acquisition finds
    // the same <video> again, but this time nothing fires 'playing' for a
    // while. The 'emptied' handler calls acquireMedia(Infinity), so this
    // wait must not time out even long past INITIAL_TIMEOUT.
    ;(video as unknown as { videoWidth: number }).videoWidth = 0
    video.dispatchEvent(new Event('emptied'))
    await vi.advanceTimersByTimeAsync(INITIAL_TIMEOUT_MS * 10)

    expect(viewErrorCalls()).toEqual([])

    // The stream eventually recovers and starts playing; the unbounded wait
    // resolves instead of having already rejected.
    ;(video as unknown as { videoWidth: number }).videoWidth = 100
    video.dispatchEvent(new Event('playing'))
    await vi.advanceTimersByTimeAsync(0)

    expect(
      send.mock.calls.filter(([channel]) => channel === 'view-loaded'),
    ).toHaveLength(2)
    expect(viewErrorCalls()).toEqual([])
  })
})

describe('mediaPreload acquisition play() rejection (issue #626)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.resetModules()
    vi.restoreAllMocks()
    invoke.mockClear()
    send.mockClear()
    on.mockClear()
    exposeInMainWorld.mockClear()
    document.body.innerHTML = ''
  })

  it('logs and swallows the acquisition play() rejection instead of leaving it unhandled', async () => {
    const video = document.createElement('video')
    // happy-dom never sets videoWidth, so give it a truthy value to skip
    // findMedia's "wait for playing" branch and let acquisition resolve as
    // soon as the element is found.
    ;(video as unknown as { videoWidth: number }).videoWidth = 100
    document.body.appendChild(video)

    // The acquisition's fire-and-forget play() rejects (e.g. autoplay policy
    // or a load interrupted by a superseding acquisition).
    const playError = new Error('play interrupted')
    const play = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockRejectedValue(playError)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    invoke.mockResolvedValueOnce({
      content: { kind: 'video', link: 'https://example.com/stream' },
      options: {},
      volume: 1,
    })

    await import('./mediaPreload')
    document.dispatchEvent(new Event('DOMContentLoaded'))
    process.emit('loaded' as never)
    await vi.advanceTimersByTimeAsync(0)

    // The rejection is caught and logged as a breadcrumb, and acquisition
    // still completes rather than being derailed or leaking an unhandled
    // rejection.
    expect(play).toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      'error starting media playback',
      playError,
    )
    expect(send).toHaveBeenCalledWith('view-loaded')
    expect(viewErrorCalls()).toEqual([])
  })
})

describe('mediaPreload iframe video extraction (issue #413)', () => {
  // Must match INITIAL_TIMEOUT in mediaPreload.ts; the iframe scan only runs
  // after the top-level <video> wait loses its race against this timeout.
  const INITIAL_TIMEOUT_MS = 10 * 1000

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.resetModules()
    invoke.mockClear()
    send.mockClear()
    on.mockClear()
    exposeInMainWorld.mockClear()
    document.body.innerHTML = ''
  })

  // A same-origin iframe embed: the <video> lives in the iframe's own
  // document, so the top-level waitForQuery never finds it and the iframe
  // scan is the only path that can.
  function appendSameOriginIframeWithVideo(): HTMLIFrameElement {
    const iframe = document.createElement('iframe')
    iframe.srcdoc = '<html><head></head><body><video></video></body></html>'
    document.body.appendChild(iframe)
    return iframe
  }

  // A cross-origin iframe has an opaque origin: the embedder can never reach
  // its DOM, so `contentDocument` reads as null.
  function appendCrossOriginIframe(): HTMLIFrameElement {
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    Object.defineProperty(iframe, 'contentDocument', { value: null })
    return iframe
  }

  async function loadVideoContent() {
    invoke.mockResolvedValueOnce({
      content: { kind: 'video', link: 'https://example.com/stream' },
      options: {},
      volume: 1,
    })
    await import('./mediaPreload')
    document.dispatchEvent(new Event('DOMContentLoaded'))
    process.emit('loaded' as never)
    await vi.advanceTimersByTimeAsync(0)
  }

  it('acquires a video embedded in a same-origin iframe and hoists it into the iframe document', async () => {
    const iframe = appendSameOriginIframeWithVideo()
    const frameDocument = iframe.contentDocument
    const video = frameDocument?.querySelector('video')
    if (!video) {
      throw new Error('test fixture: iframe document has no <video>')
    }
    // happy-dom's HTMLVideoElement never implements videoWidth, so give it a
    // truthy value to skip findMedia's "wait for playing" branch.
    ;(video as unknown as { videoWidth: number }).videoWidth = 100

    await loadVideoContent()
    await vi.advanceTimersByTimeAsync(INITIAL_TIMEOUT_MS)

    expect(viewErrorCalls()).toEqual([])
    expect(send).toHaveBeenCalledWith('view-loaded')
    // The video is moved to the iframe document's body and the iframe (plus
    // its ancestors) marked so VIDEO_OVERRIDE_STYLE can size it to the tile.
    expect(video.parentElement).toBe(frameDocument?.body)
    expect(iframe.className).toBe('__video__')
    expect(document.body.className).toBe('__video_parent__')
    expect(frameDocument?.head.querySelector('style')).not.toBeNull()
  })

  it('reports the cross-origin iframe as the specific cause instead of a generic missing video', async () => {
    appendCrossOriginIframe()

    await loadVideoContent()
    await vi.advanceTimersByTimeAsync(INITIAL_TIMEOUT_MS)

    expect(viewErrorCalls()).toEqual([
      [
        'view-error',
        {
          error: expect.objectContaining({
            message:
              'could not find video: it may be inside a cross-origin iframe, which is unsupported',
          }),
        },
      ],
    ])
  })

  it('keeps the generic message when a reachable iframe simply contains no video', async () => {
    const iframe = document.createElement('iframe')
    iframe.srcdoc = '<html><head></head><body></body></html>'
    document.body.appendChild(iframe)

    await loadVideoContent()
    await vi.advanceTimersByTimeAsync(INITIAL_TIMEOUT_MS)

    expect(viewErrorCalls()).toEqual([
      [
        'view-error',
        { error: expect.objectContaining({ message: 'could not find video' }) },
      ],
    ])
  })
})

describe('mediaPreload late iframe rescanning (issue #485)', () => {
  // Must match INITIAL_TIMEOUT in mediaPreload.ts; the search gives up once it
  // elapses, so every late insertion under test happens before it.
  const INITIAL_TIMEOUT_MS = 10 * 1000
  // Must match SCAN_THROTTLE in mediaPreload.ts: long enough for the throttled
  // rescan to run, short enough that these assertions land well before the
  // timeout would have triggered a one-shot scan on its own.
  const SCAN_THROTTLE_MS = 500

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.resetModules()
    invoke.mockClear()
    send.mockClear()
    on.mockClear()
    exposeInMainWorld.mockClear()
    document.body.innerHTML = ''
  })

  async function loadVideoContent() {
    invoke.mockResolvedValueOnce({
      content: { kind: 'video', link: 'https://example.com/stream' },
      options: {},
      volume: 1,
    })
    await import('./mediaPreload')
    document.dispatchEvent(new Event('DOMContentLoaded'))
    process.emit('loaded' as never)
    await vi.advanceTimersByTimeAsync(0)
  }

  // An empty same-origin frame whose player arrives later.
  function appendEmptyIframe(): {
    iframe: HTMLIFrameElement
    frameDocument: Document
  } {
    const iframe = document.createElement('iframe')
    iframe.srcdoc = '<html><head></head><body></body></html>'
    document.body.appendChild(iframe)
    const frameDocument = iframe.contentDocument
    if (!frameDocument) {
      throw new Error('test fixture: iframe has no document')
    }
    return { iframe, frameDocument }
  }

  it('acquires an iframe-embedded video without waiting out the initial timeout', async () => {
    const { iframe, frameDocument } = appendEmptyIframe()
    frameDocument.body.appendChild(playableVideo({ doc: frameDocument }))

    await loadVideoContent()
    await vi.advanceTimersByTimeAsync(SCAN_THROTTLE_MS)

    expect(viewErrorCalls()).toEqual([])
    expect(send).toHaveBeenCalledWith('view-loaded')
    expect(iframe.className).toBe('__video__')
  })

  it('acquires a video from an iframe inserted after the page settled', async () => {
    await loadVideoContent()
    await vi.advanceTimersByTimeAsync(INITIAL_TIMEOUT_MS / 2)

    // A slow SPA bootstrap finally inserts its player iframe. The embedder's
    // MutationObserver sees the insertion, so the scan must run again rather
    // than only once at the very end of the initial wait.
    const { iframe, frameDocument } = appendEmptyIframe()
    frameDocument.body.appendChild(playableVideo({ doc: frameDocument }))

    await vi.advanceTimersByTimeAsync(SCAN_THROTTLE_MS)

    expect(viewErrorCalls()).toEqual([])
    expect(send).toHaveBeenCalledWith('view-loaded')
    expect(iframe.className).toBe('__video__')
  })

  it('rescans an already-present iframe once it fires load with its player', async () => {
    // The frame exists from the start but is still empty (a consent gate, a
    // lazily navigated player). Its own document is outside the embedder's
    // observed tree, so only the frame's load event can announce the change.
    const { iframe, frameDocument } = appendEmptyIframe()

    await loadVideoContent()
    await vi.advanceTimersByTimeAsync(INITIAL_TIMEOUT_MS / 2)

    frameDocument.body.appendChild(playableVideo({ doc: frameDocument }))
    iframe.dispatchEvent(new Event('load'))

    await vi.advanceTimersByTimeAsync(SCAN_THROTTLE_MS)

    expect(viewErrorCalls()).toEqual([])
    expect(send).toHaveBeenCalledWith('view-loaded')
    expect(iframe.className).toBe('__video__')
  })

  it('scans iframes during an unbounded re-acquisition, which never reaches a timeout', async () => {
    const video = playableVideo()
    document.body.appendChild(video)

    await loadVideoContent()
    expect(send).toHaveBeenCalledWith('view-loaded')

    // The stream is replaced by an iframe-embedded player. The 'emptied'
    // handler re-acquires with an unbounded timeout, so a scan that only runs
    // when the search times out would never run at all here.
    video.remove()
    const { iframe, frameDocument } = appendEmptyIframe()
    frameDocument.body.appendChild(playableVideo({ doc: frameDocument }))
    video.dispatchEvent(new Event('emptied'))

    await vi.advanceTimersByTimeAsync(INITIAL_TIMEOUT_MS * 3)

    expect(viewErrorCalls()).toEqual([])
    expect(
      send.mock.calls.filter(([channel]) => channel === 'view-loaded'),
    ).toHaveLength(2)
    expect(iframe.className).toBe('__video__')
  })

  it('still reports the cross-origin cause when the frame stays unreachable for the whole search', async () => {
    await loadVideoContent()
    await vi.advanceTimersByTimeAsync(INITIAL_TIMEOUT_MS / 2)

    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    Object.defineProperty(iframe, 'contentDocument', { value: null })

    await vi.advanceTimersByTimeAsync(INITIAL_TIMEOUT_MS)

    expect(viewErrorCalls()).toEqual([
      [
        'view-error',
        {
          error: expect.objectContaining({
            message:
              'could not find video: it may be inside a cross-origin iframe, which is unsupported',
          }),
        },
      ],
    ])
  })
})

describe('mediaPreload in-frame document observation (issue #534)', () => {
  // Must match INITIAL_TIMEOUT in mediaPreload.ts; every insertion under test
  // happens well before it, so a scan that only runs when the search gives up
  // cannot be what finds the player.
  const INITIAL_TIMEOUT_MS = 10 * 1000
  // Must match SCAN_THROTTLE in mediaPreload.ts.
  const SCAN_THROTTLE_MS = 500

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.resetModules()
    invoke.mockClear()
    send.mockClear()
    on.mockClear()
    exposeInMainWorld.mockClear()
    document.body.innerHTML = ''
  })

  async function loadVideoContent() {
    invoke.mockResolvedValueOnce({
      content: { kind: 'video', link: 'https://example.com/stream' },
      options: {},
      volume: 1,
    })
    await import('./mediaPreload')
    document.dispatchEvent(new Event('DOMContentLoaded'))
    process.emit('loaded' as never)
    await vi.advanceTimersByTimeAsync(0)
  }

  function appendEmptyIframe(): {
    iframe: HTMLIFrameElement
    frameDocument: Document
  } {
    const iframe = document.createElement('iframe')
    iframe.srcdoc = '<html><head></head><body></body></html>'
    document.body.appendChild(iframe)
    const frameDocument = iframe.contentDocument
    if (!frameDocument) {
      throw new Error('test fixture: iframe has no document')
    }
    return { iframe, frameDocument }
  }

  it('acquires a video inserted by the frame itself after it finished loading', async () => {
    const { iframe, frameDocument } = appendEmptyIframe()

    await loadVideoContent()
    // The frame is loaded and empty: neither a further embedder mutation nor
    // another 'load' event will announce what its own scripts do next.
    await vi.advanceTimersByTimeAsync(SCAN_THROTTLE_MS)
    expect(send).not.toHaveBeenCalledWith('view-loaded')

    frameDocument.body.appendChild(playableVideo({ doc: frameDocument }))
    await vi.advanceTimersByTimeAsync(SCAN_THROTTLE_MS)

    expect(viewErrorCalls()).toEqual([])
    expect(send).toHaveBeenCalledWith('view-loaded')
    expect(iframe.className).toBe('__video__')
  })

  it('observes the replacement document after the frame navigates', async () => {
    const { iframe } = appendEmptyIframe()
    const initialDocument = iframe.contentDocument
    if (!initialDocument) {
      throw new Error('test fixture: iframe has no document')
    }

    await loadVideoContent()
    await vi.advanceTimersByTimeAsync(SCAN_THROTTLE_MS)

    // A navigation inside the frame discards the observed document, so the
    // observer has to be re-attached to the new one when 'load' announces it.
    const nextDocument = document.implementation.createHTMLDocument()
    Object.defineProperty(iframe, 'contentDocument', {
      configurable: true,
      get: () => nextDocument,
    })
    iframe.dispatchEvent(new Event('load'))
    await vi.advanceTimersByTimeAsync(SCAN_THROTTLE_MS)
    expect(send).not.toHaveBeenCalledWith('view-loaded')

    nextDocument.body.appendChild(playableVideo({ doc: nextDocument }))
    await vi.advanceTimersByTimeAsync(SCAN_THROTTLE_MS)

    expect(viewErrorCalls()).toEqual([])
    expect(send).toHaveBeenCalledWith('view-loaded')
    expect(iframe.className).toBe('__video__')
  })

  it('keeps reporting the cross-origin cause for frames it cannot observe', async () => {
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    Object.defineProperty(iframe, 'contentDocument', { value: null })

    await loadVideoContent()
    await vi.advanceTimersByTimeAsync(INITIAL_TIMEOUT_MS)

    expect(viewErrorCalls()).toEqual([
      [
        'view-error',
        {
          error: expect.objectContaining({
            message:
              'could not find video: it may be inside a cross-origin iframe, which is unsupported',
          }),
        },
      ],
    ])
  })
})

describe('mediaPreload MutationObserver lifecycle (issue #412)', () => {
  // Records every observer the module creates so the tests can assert on how
  // many are still connected at a given point. Deliberately inert: it never
  // delivers mutations, which is enough because waitForQuery also scans
  // eagerly and the pages under test are static.
  class FakeMutationObserver {
    static instances: FakeMutationObserver[] = []
    observe = vi.fn()
    disconnect = vi.fn()
    takeRecords = vi.fn(() => [])

    constructor(public callback: () => void) {
      FakeMutationObserver.instances.push(this)
    }
  }

  function connectedObservers() {
    return FakeMutationObserver.instances.filter(
      (observer) =>
        observer.observe.mock.calls.length > 0 &&
        observer.disconnect.mock.calls.length === 0,
    )
  }

  beforeEach(() => {
    vi.useFakeTimers()
    FakeMutationObserver.instances = []
    vi.stubGlobal('MutationObserver', FakeMutationObserver)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.resetModules()
    invoke.mockClear()
    send.mockClear()
    on.mockClear()
    exposeInMainWorld.mockClear()
    document.body.innerHTML = ''
  })

  async function loadVideoContent() {
    invoke.mockResolvedValueOnce({
      content: { kind: 'video', link: 'https://example.com/stream' },
      options: {},
      volume: 1,
    })
    await import('./mediaPreload')
    document.dispatchEvent(new Event('DOMContentLoaded'))
    process.emit('loaded' as never)
    await vi.advanceTimersByTimeAsync(0)
  }

  async function loadAcquiredVideo(): Promise<HTMLVideoElement> {
    const video = document.createElement('video')
    ;(video as unknown as { videoWidth: number }).videoWidth = 100
    document.body.appendChild(video)
    await loadVideoContent()
    expect(send).toHaveBeenCalledWith('view-loaded')
    return video
  }

  it('leaves only the long-lived lockdown observer connected once media is acquired', async () => {
    await loadAcquiredVideo()

    // The element-search observer must not outlive the search that created
    // it; only lockdownMediaTags' own observer keeps watching the document.
    expect(connectedObservers()).toHaveLength(1)
  })

  it('disconnects the element-search observer when the acquisition times out', async () => {
    // No <video> in the document, so findMedia's search runs to its timeout.
    await loadVideoContent()
    await vi.advanceTimersByTimeAsync(10 * 1000)

    expect(connectedObservers()).toHaveLength(1)
  })

  it('disconnects the observers watching frame documents when the acquisition times out', async () => {
    // A same-origin frame gets an observer of its own (issue #534), which the
    // search must tear down along with the embedder's.
    const iframe = document.createElement('iframe')
    iframe.srcdoc = '<html><head></head><body></body></html>'
    document.body.appendChild(iframe)

    await loadVideoContent()
    await vi.advanceTimersByTimeAsync(10 * 1000)

    expect(connectedObservers()).toHaveLength(1)
  })

  it('does not register a duplicate lockdown observer when media is re-acquired', async () => {
    const video = await loadAcquiredVideo()

    video.dispatchEvent(new Event('emptied'))
    await vi.advanceTimersByTimeAsync(0)

    expect(send).toHaveBeenCalledWith('view-stalled')
    expect(connectedObservers()).toHaveLength(1)
  })

  it('disconnects every remaining observer when the page goes away', async () => {
    await loadAcquiredVideo()
    expect(connectedObservers()).not.toHaveLength(0)

    window.dispatchEvent(new Event('pagehide'))

    expect(connectedObservers()).toHaveLength(0)
  })
})

describe('mediaPreload pause/resume handling (issue #374)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(async () => {
    // Some tests here never dispatch DOMContentLoaded, leaving their module
    // instance's media search pending on the page-ready gate. Run out the
    // acquisition timeout while this test's fake timers are still in charge
    // so the abandoned search aborts for good -- otherwise a later describe's
    // DOMContentLoaded would revive it against that test's document and the
    // stale instance would acquire (and start mutating) the new test's video.
    await vi.advanceTimersByTimeAsync(10 * 1000)
    vi.useRealTimers()
    vi.resetModules()
    invoke.mockClear()
    send.mockClear()
    on.mockClear()
    exposeInMainWorld.mockClear()
    document.body.innerHTML = ''
  })

  // Same acquisition setup as the emptied-handler tests above: a real <video>
  // with a truthy videoWidth so findMedia() resolves immediately instead of
  // waiting for a 'playing' event.
  async function loadAcquiredVideo(): Promise<HTMLVideoElement> {
    const video = document.createElement('video')
    ;(video as unknown as { videoWidth: number }).videoWidth = 100
    document.body.appendChild(video)

    invoke.mockResolvedValueOnce({
      content: { kind: 'video', link: 'https://example.com/stream' },
      options: {},
      volume: 1,
    })

    await import('./mediaPreload')
    document.dispatchEvent(new Event('DOMContentLoaded'))
    process.emit('loaded' as never)
    await vi.advanceTimersByTimeAsync(0)

    expect(send).toHaveBeenCalledWith('view-loaded')
    return video
  }

  it('pauses the acquired media element on a pause message, bypassing an instance-level pause override', async () => {
    const video = await loadAcquiredVideo()
    // Mirrors lockdownMediaTags' own shadowing of `pause` with a no-op (done
    // for real via webFrame.executeJavaScript against the page's main world,
    // which this preload-only harness can't exercise) -- proves the handler
    // reaches the native implementation instead of a shadowed one.
    Object.defineProperty(video, 'pause', { writable: false, value: () => {} })

    registeredHandler('pause')()

    expect(video.paused).toBe(true)
  })

  it('resumes a paused media element on a resume message', async () => {
    const video = await loadAcquiredVideo()
    video.pause()
    expect(video.paused).toBe(true)

    registeredHandler('resume')()
    await vi.advanceTimersByTimeAsync(0)

    expect(video.paused).toBe(false)
  })

  it('logs a warning when resuming playback rejects (e.g. autoplay policy)', async () => {
    // A play() rejection (autoplay policy, media detached) previously vanished
    // with an empty catch, hiding it during debugging (issue #392).
    const video = await loadAcquiredVideo()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const playErr = new Error('NotAllowedError')
    video.play = vi.fn().mockRejectedValue(playErr)

    registeredHandler('resume')()
    await vi.advanceTimersByTimeAsync(0)

    expect(warnSpy).toHaveBeenCalledWith(
      'error resuming media playback',
      playErr,
    )

    warnSpy.mockRestore()
  })

  // The bundled HLS player page (renderer/playHLS.ts) keeps its hls.js
  // instance in a closure the preload cannot reach, so pausing the <video>
  // alone leaves segment fetching to taper off on its own. These events are
  // the same-document channel that lets it call stopLoad()/startLoad()
  // instead (issue #384).
  function parkEventNames(): string[] {
    const names: string[] = []
    const record = (event: Event) => names.push(event.type)
    document.addEventListener('streamwall:media-pause', record)
    document.addEventListener('streamwall:media-resume', record)
    return names
  }

  it('announces a pause to the page world so an HLS player can stop loading segments', async () => {
    await loadAcquiredVideo()
    const events = parkEventNames()

    registeredHandler('pause')()

    expect(events).toEqual(['streamwall:media-pause'])
  })

  it('announces a resume to the page world so an HLS player can start loading again', async () => {
    await loadAcquiredVideo()
    const events = parkEventNames()

    registeredHandler('resume')()
    await vi.advanceTimersByTimeAsync(0)

    expect(events).toEqual(['streamwall:media-resume'])
  })

  it('announces pause/resume even when no media element has been acquired yet', async () => {
    invoke.mockResolvedValueOnce({
      content: { kind: 'video', link: 'https://example.com/stream' },
      options: {},
      volume: 1,
    })
    await import('./mediaPreload')
    process.emit('loaded' as never)
    await vi.advanceTimersByTimeAsync(0)
    const events = parkEventNames()

    registeredHandler('pause')()
    registeredHandler('resume')()

    expect(events).toEqual([
      'streamwall:media-pause',
      'streamwall:media-resume',
    ])
  })

  it('does not throw when a pause/resume message arrives before any media has been acquired', async () => {
    invoke.mockResolvedValueOnce({
      content: { kind: 'video', link: 'https://example.com/stream' },
      options: {},
      volume: 1,
    })
    await import('./mediaPreload')
    process.emit('loaded' as never)
    await vi.advanceTimersByTimeAsync(0)
    // No DOMContentLoaded is dispatched, so the module-scope pageReady used
    // by waitForQuery never resolves and acquireMedia never finds a video.

    expect(() => registeredHandler('pause')()).not.toThrow()
    expect(() => registeredHandler('resume')()).not.toThrow()
  })
})

describe('SnapshotController poster object URLs', () => {
  afterEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
    invoke.mockClear()
    send.mockClear()
    on.mockClear()
    exposeInMainWorld.mockClear()
  })

  function makeSnapshotHarness(controller: {
    canvas: HTMLCanvasElement
    snapshotVideo(videoEl: HTMLVideoElement): Promise<void>
  }) {
    controller.canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: vi.fn() }),
      toBlob: (callback: (blob: Blob) => void) => callback(new Blob(['png'])),
    } as unknown as HTMLCanvasElement

    let frameCallback: (() => void) | undefined
    const videoEl = {
      videoWidth: 640,
      videoHeight: 360,
      poster: '',
      requestVideoFrameCallback: (callback: () => void) => {
        frameCallback = callback
      },
    } as unknown as HTMLVideoElement

    return {
      videoEl,
      async snapshotTick() {
        await controller.snapshotVideo(videoEl)
        frameCallback!()
      },
    }
  }

  it('revokes the previous poster object URL when a new snapshot replaces it (#616)', async () => {
    const { SnapshotController } = await import('./mediaPreload')

    let urlCounter = 0
    const createObjectURL = vi
      .spyOn(URL, 'createObjectURL')
      .mockImplementation(() => `blob:snapshot-${++urlCounter}`)
    const revokeObjectURL = vi
      .spyOn(URL, 'revokeObjectURL')
      .mockImplementation(() => {})

    const controller = new SnapshotController()
    const { videoEl, snapshotTick } = makeSnapshotHarness(controller)

    await snapshotTick()
    expect(videoEl.poster).toBe('blob:snapshot-1')
    expect(revokeObjectURL).not.toHaveBeenCalled()

    await snapshotTick()
    expect(videoEl.poster).toBe('blob:snapshot-2')
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:snapshot-1')

    await snapshotTick()
    expect(videoEl.poster).toBe('blob:snapshot-3')
    expect(revokeObjectURL).toHaveBeenLastCalledWith('blob:snapshot-2')

    // One live object URL per tile at any time: each tick creates exactly one
    // URL and revokes the previous one.
    expect(createObjectURL).toHaveBeenCalledTimes(3)
    expect(revokeObjectURL).toHaveBeenCalledTimes(2)
  })
})

describe('RotationController', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    // These tests import the module for its exported class only, but that
    // import still runs main(), which now subscribes to its four operator
    // channels before awaiting the (never-resolving) view-init. Without this
    // clearing, a later describe's registeredHandler() -- which takes the
    // first matching ipcRenderer.on call -- would bind to a handler closed
    // over this dead module instance.
    invoke.mockClear()
    send.mockClear()
    on.mockClear()
    exposeInMainWorld.mockClear()
  })

  async function makeController() {
    const { RotationController } = await import('./mediaPreload')
    const video = document.createElement('video')
    return { controller: new RotationController(video), video }
  }

  it('applies each supported rotation as its matching class', async () => {
    const { controller, video } = await makeController()
    for (const rotation of [0, 90, 180, 270]) {
      controller.setCustom(rotation)
      expect(video.className).toBe(`__rot${rotation}__`)
    }
  })

  it('normalizes negative rotations into [0, 360) instead of emitting an inert class', async () => {
    const { controller, video } = await makeController()
    controller.setCustom(-90)
    expect(video.className).toBe('__rot270__')
  })

  it('normalizes rotations >= 360 into [0, 360)', async () => {
    const { controller, video } = await makeController()
    controller.setCustom(450)
    expect(video.className).toBe('__rot90__')
  })

  it('ignores an invalid rotation and keeps the current rotation class', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { controller, video } = await makeController()

    controller.setCustom(90)
    expect(video.className).toBe('__rot90__')

    // A bad value (not a multiple of 90) must not clobber the valid 90° class.
    controller.setCustom(45)
    expect(video.className).toBe('__rot90__')
    expect(warn).toHaveBeenCalledWith('ignoring invalid rotation', 45)
  })
})

describe('mediaPreload re-acquisition keeps operator-set state (issues #620/#621)', () => {
  // Must match SCAN_THROTTLE in mediaPreload.ts: long enough for the
  // re-acquisition's throttled scan to find the replacement element.
  const SCAN_THROTTLE_MS = 500

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.resetModules()
    invoke.mockClear()
    send.mockClear()
    on.mockClear()
    exposeInMainWorld.mockClear()
    document.body.innerHTML = ''
  })

  async function loadAcquiredVideo(
    options: Record<string, unknown> = {},
  ): Promise<HTMLVideoElement> {
    const video = playableVideo()
    document.body.appendChild(video)

    invoke.mockResolvedValueOnce({
      content: { kind: 'video', link: 'https://example.com/stream' },
      options,
      volume: 1,
    })

    await import('./mediaPreload')
    document.dispatchEvent(new Event('DOMContentLoaded'))
    process.emit('loaded' as never)
    await vi.advanceTimersByTimeAsync(0)

    expect(viewLoadedCalls()).toHaveLength(1)
    return video
  }

  // Simulates an HLS teardown that discards the old element entirely: the
  // page swaps in a brand-new <video>, and the 'emptied' handler's
  // re-acquisition finds that one instead of the original.
  async function reacquireOnNewElement(
    oldVideo: HTMLVideoElement,
  ): Promise<HTMLVideoElement> {
    oldVideo.remove()
    const next = playableVideo()
    document.body.appendChild(next)
    oldVideo.dispatchEvent(new Event('emptied'))
    await vi.advanceTimersByTimeAsync(SCAN_THROTTLE_MS)
    expect(viewLoadedCalls()).toHaveLength(2)
    return next
  }

  it('applies the initial rotation from view-init options once media is acquired', async () => {
    const video = await loadAcquiredVideo({ rotation: 180 })

    expect(video.className).toBe('__rot180__')
  })

  it('keeps an operator-set rotation across an emptied re-acquisition (issue #620)', async () => {
    const video = await loadAcquiredVideo()
    registeredHandler('options')(undefined, { rotation: 90 })
    expect(video.className).toBe('__rot90__')

    const next = await reacquireOnNewElement(video)

    expect(next.className).toBe('__rot90__')
  })

  it('keeps a parked view paused across an emptied re-acquisition (issue #621)', async () => {
    const video = await loadAcquiredVideo()
    registeredHandler('pause')()
    expect(video.paused).toBe(true)

    const next = await reacquireOnNewElement(video)

    expect(next.paused).toBe(true)
  })

  it('keeps a parked view paused when re-acquisition finds the same element again', async () => {
    const video = await loadAcquiredVideo()
    registeredHandler('pause')()
    expect(video.paused).toBe(true)

    video.dispatchEvent(new Event('emptied'))
    await vi.advanceTimersByTimeAsync(SCAN_THROTTLE_MS)
    expect(viewLoadedCalls()).toHaveLength(2)

    expect(video.paused).toBe(true)
  })

  it('resumes the re-acquired element on a later resume message', async () => {
    const video = await loadAcquiredVideo()
    registeredHandler('pause')()
    const next = await reacquireOnNewElement(video)
    expect(next.paused).toBe(true)

    registeredHandler('resume')()
    await vi.advanceTimersByTimeAsync(0)

    expect(next.paused).toBe(false)
  })

  it('does not pause a re-acquired element for a view that was resumed before the stall', async () => {
    const video = await loadAcquiredVideo()
    registeredHandler('pause')()
    registeredHandler('resume')()
    await vi.advanceTimersByTimeAsync(0)

    const next = await reacquireOnNewElement(video)

    expect(next.paused).toBe(false)
  })
})

describe('mediaPreload initial paused state from view-init (issue #658)', () => {
  // Must match SCAN_THROTTLE in mediaPreload.ts: long enough for the
  // re-acquisition's throttled scan to find the replacement element.
  const SCAN_THROTTLE_MS = 500

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.resetModules()
    invoke.mockClear()
    send.mockClear()
    on.mockClear()
    exposeInMainWorld.mockClear()
    document.body.innerHTML = ''
  })

  async function loadAcquiredVideo(
    init: Record<string, unknown> = {},
  ): Promise<HTMLVideoElement> {
    const video = playableVideo()
    document.body.appendChild(video)

    invoke.mockResolvedValueOnce({
      content: { kind: 'video', link: 'https://example.com/stream' },
      options: {},
      volume: 1,
      ...init,
    })

    await import('./mediaPreload')
    document.dispatchEvent(new Event('DOMContentLoaded'))
    process.emit('loaded' as never)
    await vi.advanceTimersByTimeAsync(0)

    expect(viewLoadedCalls()).toHaveLength(1)
    return video
  }

  it('pauses the acquired media when view-init reports the cell as parked-paused', async () => {
    const video = await loadAcquiredVideo({ paused: true })

    expect(video.paused).toBe(true)
  })

  it('bypasses an instance-level pause override when honoring the initial paused state', async () => {
    // Mirrors lockdownMediaTags(), which permanently shadows the element's
    // own `pause` with a no-op: the initial pause must go through
    // HTMLMediaElement.prototype.pause to have any effect.
    const shadowedPause = vi.fn()
    const video = playableVideo()
    Object.defineProperty(video, 'pause', {
      writable: false,
      value: shadowedPause,
    })
    document.body.appendChild(video)

    invoke.mockResolvedValueOnce({
      content: { kind: 'video', link: 'https://example.com/stream' },
      options: {},
      volume: 1,
      paused: true,
    })
    await import('./mediaPreload')
    document.dispatchEvent(new Event('DOMContentLoaded'))
    process.emit('loaded' as never)
    await vi.advanceTimersByTimeAsync(0)

    expect(viewLoadedCalls()).toHaveLength(1)
    expect(video.paused).toBe(true)
    expect(shadowedPause).not.toHaveBeenCalled()
  })

  it('resumes an initially-paused acquisition on a later resume message', async () => {
    const video = await loadAcquiredVideo({ paused: true })
    expect(video.paused).toBe(true)

    registeredHandler('resume')()
    await vi.advanceTimersByTimeAsync(0)

    expect(video.paused).toBe(false)
  })

  it('keeps an initially-paused view paused across an emptied re-acquisition', async () => {
    const video = await loadAcquiredVideo({ paused: true })

    video.remove()
    const next = playableVideo()
    document.body.appendChild(next)
    video.dispatchEvent(new Event('emptied'))
    await vi.advanceTimersByTimeAsync(SCAN_THROTTLE_MS)
    expect(viewLoadedCalls()).toHaveLength(2)

    expect(next.paused).toBe(true)
  })

  it('leaves playback running when view-init reports the cell as not paused', async () => {
    const video = await loadAcquiredVideo({ paused: false })

    expect(video.paused).toBe(false)
  })

  it('defaults to playing when view-init omits the paused field', async () => {
    const video = await loadAcquiredVideo()

    expect(video.paused).toBe(false)
  })
})

describe('mediaPreload paused acquisition announces the park to the page world (issue #667)', () => {
  // Must match SCAN_THROTTLE in mediaPreload.ts: long enough for the
  // re-acquisition's throttled scan to find the replacement element.
  const SCAN_THROTTLE_MS = 500

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.resetModules()
    invoke.mockClear()
    send.mockClear()
    on.mockClear()
    exposeInMainWorld.mockClear()
    document.body.innerHTML = ''
  })

  // The bundled HLS player (renderer/playHLS.ts) only stops segment fetching
  // via these document events (issue #384); its hls.js instance lives in a
  // closure the preload cannot reach. Records every park/unpark announcement
  // from registration onward; each call returns a fresh log.
  function parkEvents(): string[] {
    const names: string[] = []
    const record = (event: Event) => names.push(event.type)
    document.addEventListener('streamwall:media-pause', record)
    document.addEventListener('streamwall:media-resume', record)
    return names
  }

  async function loadAcquiredVideo(
    init: Record<string, unknown> = {},
  ): Promise<HTMLVideoElement> {
    const video = playableVideo()
    document.body.appendChild(video)

    invoke.mockResolvedValueOnce({
      content: { kind: 'video', link: 'https://example.com/stream' },
      options: {},
      volume: 1,
      ...init,
    })

    await import('./mediaPreload')
    document.dispatchEvent(new Event('DOMContentLoaded'))
    process.emit('loaded' as never)
    await vi.advanceTimersByTimeAsync(0)

    expect(viewLoadedCalls()).toHaveLength(1)
    return video
  }

  it('announces the park when an acquisition comes up initially paused', async () => {
    const events = parkEvents()

    await loadAcquiredVideo({ paused: true })

    expect(events).toEqual(['streamwall:media-pause'])
  })

  it('re-announces the park when a parked view re-acquires after an emptied teardown', async () => {
    const video = await loadAcquiredVideo()
    registeredHandler('pause')()
    expect(video.paused).toBe(true)

    // The teardown that empties the element may also have destroyed and
    // re-created the page's hls.js instance, which starts loading again and
    // was never told about the park -- the re-acquisition has to repeat the
    // announcement (issue #667).
    const events = parkEvents()
    video.remove()
    const next = playableVideo()
    document.body.appendChild(next)
    video.dispatchEvent(new Event('emptied'))
    await vi.advanceTimersByTimeAsync(SCAN_THROTTLE_MS)
    expect(viewLoadedCalls()).toHaveLength(2)

    expect(events).toEqual(['streamwall:media-pause'])
    expect(next.paused).toBe(true)
  })

  it('does not announce a park while acquiring for a view that is not paused', async () => {
    const events = parkEvents()

    const video = await loadAcquiredVideo()

    expect(events).toEqual([])
    expect(video.paused).toBe(false)
  })

  it('does not announce a park when re-acquiring for a view that was resumed before the stall', async () => {
    const video = await loadAcquiredVideo()
    registeredHandler('pause')()
    registeredHandler('resume')()
    await vi.advanceTimersByTimeAsync(0)

    const events = parkEvents()
    video.remove()
    const next = playableVideo()
    document.body.appendChild(next)
    video.dispatchEvent(new Event('emptied'))
    await vi.advanceTimersByTimeAsync(SCAN_THROTTLE_MS)
    expect(viewLoadedCalls()).toHaveLength(2)

    expect(events).toEqual([])
  })

  it('still announces the resume symmetrically after an initially-paused acquisition', async () => {
    const video = await loadAcquiredVideo({ paused: true })
    const events = parkEvents()

    registeredHandler('resume')()
    await vi.advanceTimersByTimeAsync(0)

    expect(events).toEqual(['streamwall:media-resume'])
    expect(video.paused).toBe(false)
  })
})

describe('mediaPreload IPC handlers registered before view-init (issue #756)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.resetModules()
    invoke.mockClear()
    send.mockClear()
    on.mockClear()
    exposeInMainWorld.mockClear()
    document.body.innerHTML = ''
  })

  function registeredChannels(): string[] {
    return on.mock.calls.map(([channel]) => channel as string)
  }

  // Imports the preload with the 'view-init' round trip still in flight, so a
  // test can deliver IPC in exactly the window this issue is about: after the
  // main process answered 'view-init' and dispatched to the view actor, but
  // before the renderer resumed past its own `await`.
  async function loadWithPendingViewInit(): Promise<
    (init?: Record<string, unknown>) => Promise<void>
  > {
    let resolveInit!: (payload: Record<string, unknown>) => void
    invoke.mockImplementationOnce(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          resolveInit = resolve
        }),
    )

    await import('./mediaPreload')

    return async (init: Record<string, unknown> = {}) => {
      resolveInit({
        content: { kind: 'video', link: 'https://example.com/stream' },
        options: {},
        volume: 1,
        ...init,
      })
      document.dispatchEvent(new Event('DOMContentLoaded'))
      process.emit('loaded' as never)
      await vi.advanceTimersByTimeAsync(0)
    }
  }

  it('registers the operator IPC handlers before awaiting the view-init round trip', async () => {
    await loadWithPendingViewInit()

    // Electron drops messages for channels that have no listener yet, so
    // every channel the main process may send right after answering
    // 'view-init' has to be listening already.
    expect(registeredChannels()).toEqual(
      expect.arrayContaining(['pause', 'resume', 'options', 'volume']),
    )
    // Pinned by call order rather than by "they exist once the import
    // settled": the request must go out only after every channel is
    // listening, so no suspension point can ever be introduced between the
    // two and silently reopen the window.
    const requestedAt = invoke.mock.invocationCallOrder[0]
    for (const channel of ['pause', 'resume', 'options', 'volume']) {
      const index = on.mock.calls.findIndex(([ch]) => ch === channel)
      expect(on.mock.invocationCallOrder[index]).toBeLessThan(requestedAt)
    }
  })

  it('honors a pause delivered before view-init resolved', async () => {
    const video = playableVideo({ append: true })
    const settleViewInit = await loadWithPendingViewInit()

    registeredHandler('pause')(null)
    await settleViewInit({ paused: false })

    expect(viewLoadedCalls()).toHaveLength(1)
    expect(video.paused).toBe(true)
  })

  it('does not let the view-init payload clobber a resume delivered before it resolved', async () => {
    const video = playableVideo({ append: true })
    const settleViewInit = await loadWithPendingViewInit()

    registeredHandler('resume')(null)
    await settleViewInit({ paused: true })

    expect(viewLoadedCalls()).toHaveLength(1)
    expect(video.paused).toBe(false)
  })

  it('announces an early pause to the page world at acquisition time too', async () => {
    const video = playableVideo({ append: true })
    const settleViewInit = await loadWithPendingViewInit()
    const events: string[] = []
    document.addEventListener('streamwall:media-pause', (ev) =>
      events.push(ev.type),
    )

    registeredHandler('pause')(null)
    await settleViewInit({ paused: false })

    // Once from the handler itself (no media existed yet) and once from the
    // acquisition re-asserting the park on the element it just found, so a
    // freshly created hls.js instance also learns to stop loading (#667).
    expect(events).toEqual(['streamwall:media-pause', 'streamwall:media-pause'])
    expect(video.paused).toBe(true)
  })

  it('does not let the view-init payload clobber a volume delivered before it resolved', async () => {
    const video = playableVideo({ append: true })
    const settleViewInit = await loadWithPendingViewInit()

    registeredHandler('volume')(null, 0.25)
    await settleViewInit({ volume: 1 })

    expect(video.volume).toBe(0.25)
  })

  it('keeps an early volume of 0, which a truthiness check would discard', async () => {
    // The defaulting has to be nullish (`??=`), not `||=`: a muted view is a
    // legitimate operator choice and must not fall back to the payload.
    const video = playableVideo({ append: true })
    const settleViewInit = await loadWithPendingViewInit()

    registeredHandler('volume')(null, 0)
    await settleViewInit({ volume: 1 })

    expect(video.volume).toBe(0)
  })

  it('does not let the view-init payload clobber options delivered before it resolved', async () => {
    const video = playableVideo({ append: true })
    const settleViewInit = await loadWithPendingViewInit()

    registeredHandler('options')(null, { rotation: 90 })
    await settleViewInit({ options: { rotation: 180 } })

    expect(video.className).toBe('__rot90__')
  })

  it('still applies the view-init payload when no message arrived early', async () => {
    const video = playableVideo({ append: true })
    const settleViewInit = await loadWithPendingViewInit()

    await settleViewInit({
      paused: true,
      volume: 0.5,
      options: { rotation: 270 },
    })

    expect(video.paused).toBe(true)
    expect(video.volume).toBe(0.5)
    expect(video.className).toBe('__rot270__')
  })

  it('acquires media when view-init reports no display options yet', async () => {
    // The view actor's `context.options` starts out null and only becomes an
    // object once it has seen an OPTIONS event, so the payload legitimately
    // carries null. Dereferencing it must not abort main() before the
    // acquisition it now precedes.
    const video = playableVideo({ append: true })
    const settleViewInit = await loadWithPendingViewInit()

    await settleViewInit({ options: null })

    expect(viewLoadedCalls()).toHaveLength(1)
    expect(video.className).toBe('__rot0__')
    // Not just "the view still loads": before the guard, dereferencing the
    // null threw out of main() and put the tile into an error state.
    expect(send).not.toHaveBeenCalledWith('view-error', expect.anything())
  })
})
