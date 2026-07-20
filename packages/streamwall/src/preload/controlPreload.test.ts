// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
const on = vi.fn()
const off = vi.fn()
const exposeInMainWorld = vi.fn()

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke, on, off },
}))

// sentryPreload has its own dedicated test coverage; stub it here so
// controlPreload tests exercise only the bridge this file declares.
vi.mock('./sentryPreload', () => ({}))

type ControlApi = {
  load: () => unknown
  openDevTools: () => unknown
  invokeCommand: (msg: object) => unknown
  updateYDoc: (update: Uint8Array) => unknown
  getFirstRunInfo: () => unknown
  openConfigFolder: () => unknown
  createExampleConfig: () => unknown
  onState: (handleState: (state: unknown) => void) => () => void
  onYDoc: (handleUpdate: (update: Uint8Array) => void) => () => void
}

function importedControlApi(): ControlApi {
  const call = exposeInMainWorld.mock.calls.find(
    ([name]) => name === 'streamwallControl',
  )
  if (!call) throw new Error('streamwallControl was not exposed')
  return call[1] as ControlApi
}

afterEach(() => {
  vi.resetModules()
  invoke.mockClear()
  on.mockClear()
  off.mockClear()
  exposeInMainWorld.mockClear()
})

describe('controlPreload bridge shape', () => {
  it('exposes exactly the expected keys on streamwallControl', async () => {
    await import('./controlPreload')

    expect(Object.keys(importedControlApi()).sort()).toEqual(
      [
        'createExampleConfig',
        'getFirstRunInfo',
        'invokeCommand',
        'load',
        'onState',
        'onYDoc',
        'openConfigFolder',
        'openDevTools',
        'updateYDoc',
      ].sort(),
    )
  })
})

describe('controlPreload channel wiring', () => {
  it('forwards invokeCommand payloads unchanged to control:command', async () => {
    await import('./controlPreload')
    const msg = { type: 'set-view', id: 'abc' }

    importedControlApi().invokeCommand(msg)

    expect(invoke).toHaveBeenCalledWith('control:command', msg)
  })

  it('forwards updateYDoc payloads unchanged to control:ydoc', async () => {
    await import('./controlPreload')
    const update = new Uint8Array([1, 2, 3])

    importedControlApi().updateYDoc(update)

    expect(invoke).toHaveBeenCalledWith('control:ydoc', update)
  })

  it.each([
    ['load', 'control:load'],
    ['openDevTools', 'control:devtools'],
    ['getFirstRunInfo', 'control:first-run-info'],
    ['openConfigFolder', 'control:open-config-folder'],
    ['createExampleConfig', 'control:create-example-config'],
  ] as const)('invokes %s on the %s channel', async (method, channel) => {
    await import('./controlPreload')

    importedControlApi()[method]()

    expect(invoke).toHaveBeenCalledWith(channel)
  })
})

describe('controlPreload onState listener lifecycle', () => {
  it('subscribes to the state IPC channel and forwards the state payload', async () => {
    await import('./controlPreload')
    const handleState = vi.fn()

    importedControlApi().onState(handleState)

    expect(on).toHaveBeenCalledWith('state', expect.any(Function))
    const [, internalHandler] = on.mock.calls.find(([ch]) => ch === 'state')!
    const state = { streams: [] }
    internalHandler({}, state)

    expect(handleState).toHaveBeenCalledWith(state)
  })

  it('removes the same listener it registered when unsubscribed', async () => {
    await import('./controlPreload')

    const unsubscribe = importedControlApi().onState(vi.fn())
    const [, internalHandler] = on.mock.calls.find(([ch]) => ch === 'state')!

    unsubscribe()

    expect(off).toHaveBeenCalledWith('state', internalHandler)
  })
})

describe('controlPreload onYDoc listener lifecycle', () => {
  it('subscribes to the ydoc IPC channel and forwards the update payload', async () => {
    await import('./controlPreload')
    const handleUpdate = vi.fn()

    importedControlApi().onYDoc(handleUpdate)

    expect(on).toHaveBeenCalledWith('ydoc', expect.any(Function))
    const [, internalHandler] = on.mock.calls.find(([ch]) => ch === 'ydoc')!
    const update = new Uint8Array([9, 8, 7])
    internalHandler({}, update)

    expect(handleUpdate).toHaveBeenCalledWith(update)
  })

  it('removes the same listener it registered when unsubscribed', async () => {
    await import('./controlPreload')

    const unsubscribe = importedControlApi().onYDoc(vi.fn())
    const [, internalHandler] = on.mock.calls.find(([ch]) => ch === 'ydoc')!

    unsubscribe()

    expect(off).toHaveBeenCalledWith('ydoc', internalHandler)
  })
})
