// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

const executeJavaScript = vi.fn()
// Never resolves, so the assertions below can prove the visibility spoof
// does not wait on the view-init round trip before running.
const invoke = vi.fn(() => new Promise(() => {}))

vi.mock('electron', () => ({
  ipcRenderer: { invoke, send: vi.fn(), on: vi.fn() },
  webFrame: { executeJavaScript, insertCSS: vi.fn() },
}))

describe('mediaPreload visibility spoofing', () => {
  afterEach(() => {
    vi.resetModules()
    executeJavaScript.mockClear()
    invoke.mockClear()
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
