import { type CollabTransportEvents } from 'streamwall-control-ui'
import { describe, expect, it, vi } from 'vitest'
import { type StreamwallControlGlobal } from '../preload/controlPreload'
import { createIpcCollabTransport } from './ipcCollabTransport'

function createMockControl() {
  const onStateUnsubscribe = vi.fn()
  const onYDocUnsubscribe = vi.fn()
  const control = {
    invokeCommand: vi.fn().mockResolvedValue({ response: true, ok: 1 }),
    updateYDoc: vi.fn(),
    onState: vi.fn().mockReturnValue(onStateUnsubscribe),
    onYDoc: vi.fn().mockReturnValue(onYDocUnsubscribe),
    load: vi.fn(),
  }
  return {
    control: control as unknown as StreamwallControlGlobal,
    mocks: control,
    onStateUnsubscribe,
    onYDocUnsubscribe,
  }
}

function noopEvents(
  overrides: Partial<CollabTransportEvents> = {},
): CollabTransportEvents {
  return {
    onState: vi.fn(),
    onConnected: vi.fn(),
    onClose: vi.fn(),
    onDisconnectReason: vi.fn(),
    ...overrides,
  }
}

describe('createIpcCollabTransport', () => {
  it('reports an always-on link: app origin, initially connected', () => {
    const { control } = createMockControl()
    const transport = createIpcCollabTransport(control)

    expect(transport.remoteOrigin).toBe('app')
    expect(transport.initiallyConnected).toBe(true)
  })

  it('sends a command over IPC and forwards the response to the callback', async () => {
    const { control, mocks } = createMockControl()
    const transport = createIpcCollabTransport(control)
    const cb = vi.fn()
    const command = { type: 'create-invite', name: 'x', role: 'operator' }

    await transport.send(command as never, cb)

    expect(mocks.invokeCommand).toHaveBeenCalledWith(command)
    expect(cb).toHaveBeenCalledWith({ response: true, ok: 1 })
  })

  it('tolerates a command sent without a callback', async () => {
    const { control, mocks } = createMockControl()
    const transport = createIpcCollabTransport(control)

    await expect(
      transport.send({ type: 'reload-view', viewIdx: 0 } as never),
    ).resolves.toBeUndefined()
    expect(mocks.invokeCommand).toHaveBeenCalledTimes(1)
  })

  it('forwards local Yjs updates to the main process', () => {
    const { control, mocks } = createMockControl()
    const transport = createIpcCollabTransport(control)
    const update = new Uint8Array([1, 2, 3])

    transport.sendYDocUpdate(update)

    expect(mocks.updateYDoc).toHaveBeenCalledWith(update)
  })

  it('subscribes to Yjs updates via onYDoc and returns its unsubscribe', () => {
    const { control, mocks, onYDocUnsubscribe } = createMockControl()
    const transport = createIpcCollabTransport(control)
    const cb = vi.fn()

    const unsubscribe = transport.subscribeYDocUpdates(cb)

    expect(mocks.onYDoc).toHaveBeenCalledWith(cb)
    expect(onYDocUnsubscribe).not.toHaveBeenCalled()
    unsubscribe()
    expect(onYDocUnsubscribe).toHaveBeenCalledTimes(1)
  })

  describe('connect', () => {
    it('wires onState, marks connected, then requests the initial load', () => {
      const { control, mocks } = createMockControl()
      const transport = createIpcCollabTransport(control)
      const events = noopEvents()

      transport.connect(events)

      expect(mocks.onState).toHaveBeenCalledWith(events.onState)
      expect(events.onConnected).toHaveBeenCalledTimes(1)
      expect(mocks.load).toHaveBeenCalledTimes(1)
      // The listener must be attached before load() so the pushed state and
      // Yjs snapshot are not missed.
      const onStateOrder = mocks.onState.mock.invocationCallOrder[0]!
      const loadOrder = mocks.load.mock.invocationCallOrder[0]!
      expect(onStateOrder).toBeLessThan(loadOrder)
    })

    it('never closes the connection (main process is always up)', () => {
      const { control } = createMockControl()
      const transport = createIpcCollabTransport(control)
      const events = noopEvents()

      transport.connect(events)

      expect(events.onClose).not.toHaveBeenCalled()
      expect(events.onDisconnectReason).not.toHaveBeenCalled()
    })

    it('returns the onState unsubscribe as its teardown', () => {
      const { control, onStateUnsubscribe } = createMockControl()
      const transport = createIpcCollabTransport(control)

      const teardown = transport.connect(noopEvents())
      expect(onStateUnsubscribe).not.toHaveBeenCalled()

      teardown()
      expect(onStateUnsubscribe).toHaveBeenCalledTimes(1)
    })
  })
})
