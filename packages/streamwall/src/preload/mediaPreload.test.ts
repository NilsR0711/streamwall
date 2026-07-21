// @vitest-environment happy-dom
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

  function viewErrorCalls() {
    return send.mock.calls.filter(([channel]) => channel === 'view-error')
  }

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

  function viewErrorCalls() {
    return send.mock.calls.filter(([channel]) => channel === 'view-error')
  }

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

  function viewErrorCalls() {
    return send.mock.calls.filter(([channel]) => channel === 'view-error')
  }

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

describe('mediaPreload pause/resume handling (issue #374)', () => {
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

  function registeredHandler(channel: string): () => void {
    const call = on.mock.calls.find(([ch]) => ch === channel)
    if (!call) {
      throw new Error(`no ipcRenderer.on('${channel}', ...) handler registered`)
    }
    return call[1] as () => void
  }

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
