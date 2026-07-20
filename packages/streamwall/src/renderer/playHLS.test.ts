// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ErrorTypes = {
  NETWORK_ERROR: 'networkError',
  MEDIA_ERROR: 'mediaError',
  KEY_SYSTEM_ERROR: 'keySystemError',
  MUX_ERROR: 'muxError',
  OTHER_ERROR: 'otherError',
}

const Events = {
  MANIFEST_PARSED: 'hlsManifestParsed',
  ERROR: 'hlsError',
}

let lastInstance: MockHls | undefined

function registerInstance(instance: MockHls) {
  lastInstance = instance
}

class MockHls {
  static isSupported = vi.fn(() => true)

  attachMedia = vi.fn()
  loadSource = vi.fn()
  startLoad = vi.fn()
  stopLoad = vi.fn()
  recoverMediaError = vi.fn()
  destroy = vi.fn()

  listeners = new Map<string, Array<(...args: unknown[]) => void>>()

  on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    const handlers = this.listeners.get(event) ?? []
    handlers.push(handler)
    this.listeners.set(event, handlers)
  })

  emit(event: string, data?: unknown) {
    for (const handler of this.listeners.get(event) ?? []) {
      handler(event, data)
    }
  }

  constructor() {
    registerInstance(this)
  }
}

vi.mock('hls.js', () => ({
  default: MockHls,
  Events,
  ErrorTypes,
}))

function setSrc(src: string | null) {
  const url = new URL('/playHLS.html', window.location.href)
  if (src) url.searchParams.set('src', src)
  window.history.pushState({}, '', url.pathname + url.search)
}

const reportError = vi.fn()

describe('playHLS', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    lastInstance = undefined
    MockHls.isSupported.mockReturnValue(true)
    reportError.mockClear()
    ;(window as unknown as { streamwallMedia: unknown }).streamwallMedia = {
      reportError,
    }
  })

  afterEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
    delete (window as unknown as { streamwallMedia?: unknown }).streamwallMedia
  })

  it('does nothing when no src query param is present', async () => {
    setSrc(null)
    await import('./playHLS')

    expect(lastInstance).toBeUndefined()
    expect(document.querySelector('video')).toBeNull()
  })

  it('rejects a src with a disallowed protocol instead of loading or assigning it to a video element', async () => {
    setSrc('javascript:alert(document.domain)')
    await import('./playHLS')

    expect(lastInstance).toBeUndefined()
    expect(document.querySelector('video')).toBeNull()
  })

  it('reports a rejected src promptly instead of leaving the tile black', async () => {
    setSrc('javascript:alert(document.domain)')
    await import('./playHLS')

    expect(reportError).toHaveBeenCalledWith('src-rejected')
  })

  it('does not report an error when playback proceeds normally', async () => {
    setSrc('https://stream.example/live.m3u8')
    await import('./playHLS')

    expect(reportError).not.toHaveBeenCalled()
  })

  it('appends the video element once the manifest has parsed', async () => {
    setSrc('https://stream.example/live.m3u8')
    await import('./playHLS')

    expect(lastInstance).toBeDefined()
    expect(lastInstance!.loadSource).toHaveBeenCalledWith(
      'https://stream.example/live.m3u8',
    )
    expect(document.querySelector('video')).toBeNull()

    lastInstance!.emit(Events.MANIFEST_PARSED)

    expect(document.querySelector('video')).not.toBeNull()
  })

  it('retries recoverable network errors via startLoad', async () => {
    setSrc('https://stream.example/live.m3u8')
    await import('./playHLS')

    lastInstance!.emit(Events.ERROR, {
      type: ErrorTypes.NETWORK_ERROR,
      fatal: true,
    })

    expect(lastInstance!.startLoad).toHaveBeenCalledTimes(1)
    expect(lastInstance!.destroy).not.toHaveBeenCalled()
  })

  it('retries recoverable media errors via recoverMediaError', async () => {
    setSrc('https://stream.example/live.m3u8')
    await import('./playHLS')

    lastInstance!.emit(Events.ERROR, {
      type: ErrorTypes.MEDIA_ERROR,
      fatal: true,
    })

    expect(lastInstance!.recoverMediaError).toHaveBeenCalledTimes(1)
    expect(lastInstance!.destroy).not.toHaveBeenCalled()
  })

  it('ignores non-fatal errors', async () => {
    setSrc('https://stream.example/live.m3u8')
    await import('./playHLS')

    lastInstance!.emit(Events.ERROR, {
      type: ErrorTypes.NETWORK_ERROR,
      fatal: false,
    })

    expect(lastInstance!.startLoad).not.toHaveBeenCalled()
    expect(lastInstance!.recoverMediaError).not.toHaveBeenCalled()
    expect(lastInstance!.destroy).not.toHaveBeenCalled()
  })

  it('destroys the player on an unrecoverable fatal error', async () => {
    setSrc('https://stream.example/live.m3u8')
    await import('./playHLS')

    lastInstance!.emit(Events.ERROR, {
      type: ErrorTypes.OTHER_ERROR,
      fatal: true,
    })

    expect(lastInstance!.destroy).toHaveBeenCalledTimes(1)
  })

  it('stops retrying network errors and destroys after exceeding the retry limit', async () => {
    setSrc('https://stream.example/live.m3u8')
    await import('./playHLS')

    for (let i = 0; i < 10; i++) {
      lastInstance!.emit(Events.ERROR, {
        type: ErrorTypes.NETWORK_ERROR,
        fatal: true,
      })
    }

    expect(lastInstance!.startLoad.mock.calls.length).toBeLessThan(10)
    expect(lastInstance!.destroy).toHaveBeenCalledTimes(1)
  })

  it('destroys the hls instance on pagehide for teardown', async () => {
    setSrc('https://stream.example/live.m3u8')
    await import('./playHLS')

    window.dispatchEvent(new Event('pagehide'))

    expect(lastInstance!.destroy).toHaveBeenCalledTimes(1)
  })

  it('stops hls.js segment loading when the view is parked (issue #384)', async () => {
    setSrc('https://stream.example/live.m3u8')
    await import('./playHLS')

    document.dispatchEvent(new CustomEvent('streamwall:media-pause'))

    expect(lastInstance!.stopLoad).toHaveBeenCalledTimes(1)
    expect(lastInstance!.destroy).not.toHaveBeenCalled()
  })

  it('resumes hls.js segment loading when the parked view is unparked', async () => {
    setSrc('https://stream.example/live.m3u8')
    await import('./playHLS')

    document.dispatchEvent(new CustomEvent('streamwall:media-pause'))
    document.dispatchEvent(new CustomEvent('streamwall:media-resume'))

    expect(lastInstance!.startLoad).toHaveBeenCalledTimes(1)
  })

  it('ignores park events after teardown instead of touching a destroyed instance', async () => {
    setSrc('https://stream.example/live.m3u8')
    await import('./playHLS')

    window.dispatchEvent(new Event('pagehide'))
    document.dispatchEvent(new CustomEvent('streamwall:media-pause'))
    document.dispatchEvent(new CustomEvent('streamwall:media-resume'))

    expect(lastInstance!.stopLoad).not.toHaveBeenCalled()
    expect(lastInstance!.startLoad).not.toHaveBeenCalled()
  })

  it('falls back to native playback and appends the video once metadata loads', async () => {
    const hlsModule = await import('hls.js')
    vi.spyOn(hlsModule.default, 'isSupported').mockReturnValue(false)
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue(
      'probably',
    )

    const realCreateElement = document.createElement.bind(document)
    let createdVideo: HTMLVideoElement | undefined
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreateElement(tag)
      if (tag === 'video') createdVideo = el as HTMLVideoElement
      return el
    })

    setSrc('https://stream.example/live.m3u8')
    await import('./playHLS')

    expect(lastInstance).toBeUndefined()
    expect(createdVideo).toBeDefined()
    expect(createdVideo!.src).toContain('live.m3u8')
    expect(document.body.contains(createdVideo!)).toBe(false)

    createdVideo!.dispatchEvent(new Event('loadedmetadata'))

    expect(document.body.contains(createdVideo!)).toBe(true)
  })

  it('never appends a video when neither hls.js nor native HLS playback is supported', async () => {
    const hlsModule = await import('hls.js')
    vi.spyOn(hlsModule.default, 'isSupported').mockReturnValue(false)
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('')

    setSrc('https://stream.example/live.m3u8')
    await import('./playHLS')

    expect(lastInstance).toBeUndefined()
    expect(document.querySelector('video')).toBeNull()
  })

  it('reports HLS as unsupported instead of relying on the load timeout', async () => {
    const hlsModule = await import('hls.js')
    vi.spyOn(hlsModule.default, 'isSupported').mockReturnValue(false)
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('')

    setSrc('https://stream.example/live.m3u8')
    await import('./playHLS')

    expect(reportError).toHaveBeenCalledWith('hls-unsupported')
  })
})
