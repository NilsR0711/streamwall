// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

const executeJavaScript = vi.fn()
// Never resolves, so the assertions below can prove the visibility spoof
// does not wait on the view-init round trip before running.
const invoke = vi.fn(() => new Promise(() => {}))
const send = vi.fn()
const exposeInMainWorld = vi.fn()

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke, send, on: vi.fn() },
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
