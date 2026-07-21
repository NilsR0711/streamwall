import { type CollabTransportEvents } from 'streamwall-control-ui'
import { type StreamwallState } from 'streamwall-shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type StreamwallControlGlobal } from '../preload/controlPreload'
import { createIpcCollabTransport } from './ipcCollabTransport'

/** A minimal snapshot that satisfies `streamwallStateSchema`. */
const VALID_STATE = {
  identity: { role: 'local' },
  config: {
    cols: 3,
    rows: 3,
    width: 1920,
    height: 1080,
    frameless: false,
    fullscreen: false,
    activeColor: '#fff',
    backgroundColor: '#000',
  },
  streams: [],
  customStreams: [],
  views: [],
  fullscreenViewIdx: null,
  streamdelay: null,
  layoutPresets: [],
  favorites: [],
  dataSourceHealth: [],
} as unknown as StreamwallState

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

      expect(mocks.onState).toHaveBeenCalledTimes(1)
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

  describe('state validation', () => {
    let warn: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    })

    afterEach(() => {
      warn.mockRestore()
    })

    /** Connects the transport and returns the handler the preload received. */
    function connectAndGetStateHandler(events: CollabTransportEvents) {
      const { control, mocks } = createMockControl()
      createIpcCollabTransport(control).connect(events)
      return mocks.onState.mock.calls[0]![0] as (state: unknown) => void
    }

    it('forwards a valid snapshot unchanged', () => {
      const events = noopEvents()
      const handleState = connectAndGetStateHandler(events)

      handleState(VALID_STATE)

      expect(events.onState).toHaveBeenCalledTimes(1)
      // Passed through by reference: validation is a gate, not a transform, so
      // no field the schema does not model gets stripped on the way through.
      expect(events.onState).toHaveBeenCalledWith(VALID_STATE)
      expect(warn).not.toHaveBeenCalled()
    })

    it.each([
      ['a non-object payload', 'nope'],
      ['a null payload', null],
      ['a snapshot missing required keys', { identity: { role: 'local' } }],
      [
        'a snapshot with a malformed views array',
        { ...VALID_STATE, views: [{ state: 'bogus' }] },
      ],
      [
        'a snapshot with a non-array streams field',
        { ...VALID_STATE, streams: {} },
      ],
      [
        'a snapshot with an unknown identity role',
        { ...VALID_STATE, identity: { role: 'superuser' } },
      ],
    ])('drops %s and logs it', (_label, payload) => {
      const events = noopEvents()
      const handleState = connectAndGetStateHandler(events)

      handleState(payload)

      expect(events.onState).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledTimes(1)
    })

    it('keeps serving the last valid snapshot when an invalid one arrives', () => {
      const events = noopEvents()
      const handleState = connectAndGetStateHandler(events)

      handleState(VALID_STATE)
      handleState({ ...VALID_STATE, config: null })

      // Only the good snapshot reached the shared hook, so the UI keeps
      // rendering it instead of blanking on the malformed update.
      expect(events.onState).toHaveBeenCalledTimes(1)
      expect(events.onState).toHaveBeenCalledWith(VALID_STATE)
    })

    it('recovers once valid snapshots resume', () => {
      const events = noopEvents()
      const handleState = connectAndGetStateHandler(events)

      handleState({ ...VALID_STATE, favorites: 'nope' })
      handleState(VALID_STATE)

      expect(events.onState).toHaveBeenCalledTimes(1)
      expect(events.onState).toHaveBeenLastCalledWith(VALID_STATE)
    })
  })
})
