// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
const send = vi.fn()
const on = vi.fn()
const off = vi.fn()
const exposeInMainWorld = vi.fn()

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke, send, on, off },
}))

// sentryPreload has its own dedicated test coverage; stub it here so
// layerPreload tests exercise only the bridge this file declares.
vi.mock('./sentryPreload', () => ({}))

type LayerApi = {
  openDevTools: () => unknown
  load: () => unknown
  onState: (handleState: (state: unknown) => void) => () => void
}

function importedLayerApi(): LayerApi {
  const call = exposeInMainWorld.mock.calls.find(
    ([name]) => name === 'streamwallLayer',
  )
  if (!call) throw new Error('streamwallLayer was not exposed')
  return call[1] as LayerApi
}

afterEach(() => {
  vi.resetModules()
  invoke.mockClear()
  send.mockClear()
  on.mockClear()
  off.mockClear()
  exposeInMainWorld.mockClear()
})

describe('layerPreload bridge shape', () => {
  it('exposes exactly the expected keys on streamwallLayer', async () => {
    await import('./layerPreload')

    expect(Object.keys(importedLayerApi()).sort()).toEqual(
      ['load', 'onState', 'openDevTools'].sort(),
    )
  })

  it('does not expose any Node/Electron globals beyond the declared streamwallLayer bridge', async () => {
    await import('./layerPreload')

    expect(exposeInMainWorld).toHaveBeenCalledTimes(1)
    expect(exposeInMainWorld).toHaveBeenCalledWith(
      'streamwallLayer',
      expect.any(Object),
    )
  })
})

describe('layerPreload channel wiring', () => {
  it('sends devtools-overlay (fire-and-forget) instead of invoking it', async () => {
    await import('./layerPreload')

    importedLayerApi().openDevTools()

    expect(send).toHaveBeenCalledWith('devtools-overlay')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('invokes layer:load', async () => {
    await import('./layerPreload')

    importedLayerApi().load()

    expect(invoke).toHaveBeenCalledWith('layer:load')
  })
})

describe('layerPreload onState listener lifecycle', () => {
  it('subscribes to the state IPC channel and forwards the state payload', async () => {
    await import('./layerPreload')
    const handleState = vi.fn()

    importedLayerApi().onState(handleState)

    expect(on).toHaveBeenCalledWith('state', expect.any(Function))
    const [, internalHandler] = on.mock.calls.find(([ch]) => ch === 'state')!
    const state = { streams: [] }
    internalHandler({}, state)

    expect(handleState).toHaveBeenCalledWith(state)
  })

  it('removes the same listener it registered when unsubscribed', async () => {
    await import('./layerPreload')

    const unsubscribe = importedLayerApi().onState(vi.fn())
    const [, internalHandler] = on.mock.calls.find(([ch]) => ch === 'state')!

    unsubscribe()

    expect(off).toHaveBeenCalledWith('state', internalHandler)
  })
})
