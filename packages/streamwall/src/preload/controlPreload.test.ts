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
  getAppVersion: () => unknown
  getUpdateStatus: () => unknown
  installUpdate: () => unknown
  openReleaseNotes: () => unknown
  onState: (handleState: (state: unknown) => void) => () => void
  onYDoc: (handleUpdate: (update: Uint8Array) => void) => () => void
  onUpdateStatus: (handleStatus: (status: unknown) => void) => () => void
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
        'getAppVersion',
        'getFirstRunInfo',
        'getUpdateStatus',
        'installUpdate',
        'invokeCommand',
        'load',
        'onState',
        'onUpdateStatus',
        'onYDoc',
        'openConfigFolder',
        'openDevTools',
        'openReleaseNotes',
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
    ['getAppVersion', 'control:app-version'],
    ['getUpdateStatus', 'control:update-status'],
    ['installUpdate', 'control:install-update'],
    ['openReleaseNotes', 'control:open-release-notes'],
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

describe('controlPreload onUpdateStatus listener lifecycle', () => {
  it('subscribes to the update-status IPC channel and forwards the status payload', async () => {
    await import('./controlPreload')
    const handleStatus = vi.fn()

    importedControlApi().onUpdateStatus(handleStatus)

    expect(on).toHaveBeenCalledWith('update-status', expect.any(Function))
    const [, internalHandler] = on.mock.calls.find(
      ([ch]) => ch === 'update-status',
    )!
    const status = { state: 'ready', version: '0.9.2', releaseNotesUrl: null }
    internalHandler({}, status)

    expect(handleStatus).toHaveBeenCalledWith(status)
  })

  it('removes the same listener it registered when unsubscribed', async () => {
    await import('./controlPreload')

    const unsubscribe = importedControlApi().onUpdateStatus(vi.fn())
    const [, internalHandler] = on.mock.calls.find(
      ([ch]) => ch === 'update-status',
    )!

    unsubscribe()

    expect(off).toHaveBeenCalledWith('update-status', internalHandler)
  })
})

describe('controlPreload update bridge safety', () => {
  it('sends no renderer-supplied URL when opening release notes, so the target cannot be spoofed', async () => {
    await import('./controlPreload')

    // A compromised renderer could only ever call this with arguments; the
    // bridge must drop them so main opens the release it actually downloaded.
    ;(importedControlApi().openReleaseNotes as (...args: unknown[]) => unknown)(
      'https://evil.example/pwn',
    )

    expect(invoke).toHaveBeenCalledWith('control:open-release-notes')
  })
})
