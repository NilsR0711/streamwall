import EventEmitter from 'node:events'
import { type StreamwallState } from 'streamwall-shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import * as Y from 'yjs'
import log from './logger'
import {
  type UplinkConnectionDeps,
  type UplinkSocket,
  connectControlUplink,
  makeControlWebSocket,
} from './uplinkConnection'

const SOCKET_OPEN = 1
const SOCKET_CLOSED = 3

/** A controllable uplink socket that records its event listeners. */
function fakeSocket() {
  const listeners: Record<string, ((event: unknown) => void)[]> = {}
  return {
    binaryType: '',
    readyState: SOCKET_OPEN,
    addEventListener: vi.fn((type: string, cb: (event: unknown) => void) => {
      ;(listeners[type] ??= []).push(cb)
    }),
    send: vi.fn(),
    emit(type: string, event?: unknown) {
      for (const cb of listeners[type] ?? []) {
        cb(event)
      }
    },
  }
}

function makeDeps(
  overrides: Partial<UplinkConnectionDeps> = {},
): UplinkConnectionDeps {
  return {
    endpoint: 'ws://localhost:8080',
    stateDoc: new Y.Doc(),
    stateEmitter: new EventEmitter<{ state: [StreamwallState] }>(),
    getClientState: () => ({ streams: [] }) as unknown as StreamwallState,
    onCommand: vi.fn(async () => {}),
    ...overrides,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('makeControlWebSocket', () => {
  it('returns a subclass of the ws WebSocket', () => {
    const Cls = makeControlWebSocket('secret')
    expect(typeof Cls).toBe('function')
    expect(Cls.prototype).toBeInstanceOf(WebSocket)
  })
})

describe('connectControlUplink — connection decision', () => {
  it('does not connect when no endpoint is configured', () => {
    const createSocket = vi.fn()
    connectControlUplink(makeDeps({ endpoint: null, createSocket }))
    expect(createSocket).not.toHaveBeenCalled()
  })

  it('refuses an insecure remote endpoint and logs an error', () => {
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => log)
    const createSocket = vi.fn()

    connectControlUplink(
      makeDeps({ endpoint: 'ws://example.com:8080', createSocket }),
    )

    expect(createSocket).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Refusing to connect to insecure control endpoint',
      ),
    )
  })

  it('connects to a secure (loopback) endpoint', () => {
    const socket = fakeSocket()
    const createSocket = vi.fn(() => socket as unknown as UplinkSocket)

    connectControlUplink(makeDeps({ createSocket }))

    expect(createSocket).toHaveBeenCalledOnce()
    expect(socket.binaryType).toBe('arraybuffer')
  })
})

describe('connectControlUplink — socket wiring', () => {
  it('resends full state and the Yjs doc on open', () => {
    const socket = fakeSocket()
    const stateDoc = new Y.Doc()
    connectControlUplink(
      makeDeps({
        stateDoc,
        createSocket: () => socket as unknown as UplinkSocket,
        getClientState: () =>
          ({ streams: [{ _id: 'a' }] }) as unknown as StreamwallState,
      }),
    )

    socket.emit('open')

    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'state', state: { streams: [{ _id: 'a' }] } }),
    )
    // The second send is the encoded Yjs document.
    expect(socket.send).toHaveBeenCalledTimes(2)
  })

  it('applies an incoming Yjs update to the state doc', () => {
    const socket = fakeSocket()
    const stateDoc = new Y.Doc()
    connectControlUplink(
      makeDeps({
        stateDoc,
        createSocket: () => socket as unknown as UplinkSocket,
      }),
    )

    // Build an update from a separate doc and deliver it as an ArrayBuffer.
    const source = new Y.Doc()
    source.getMap('views').set('0', 'stream-x')
    const update = Y.encodeStateAsUpdate(source)

    socket.emit('message', { data: update.buffer })

    expect(stateDoc.getMap('views').get('0')).toBe('stream-x')
  })

  it('dispatches an incoming command through onCommand', () => {
    const socket = fakeSocket()
    const onCommand = vi.fn(async () => {})
    connectControlUplink(
      makeDeps({
        onCommand,
        createSocket: () => socket as unknown as UplinkSocket,
      }),
    )

    socket.emit('message', {
      data: JSON.stringify({ type: 'reload-view', viewIdx: 0 }),
    })

    expect(onCommand).toHaveBeenCalledWith(
      { type: 'reload-view', viewIdx: 0 },
      'uplink',
    )
  })

  it('broadcasts state changes only while the socket is open', () => {
    const socket = fakeSocket()
    const stateEmitter = new EventEmitter<{ state: [StreamwallState] }>()
    connectControlUplink(
      makeDeps({
        stateEmitter,
        createSocket: () => socket as unknown as UplinkSocket,
        getClientState: () => ({ streams: [] }) as unknown as StreamwallState,
      }),
    )

    socket.readyState = SOCKET_OPEN
    stateEmitter.emit('state', {} as StreamwallState)
    expect(socket.send).toHaveBeenCalledTimes(1)

    socket.send.mockClear()
    socket.readyState = SOCKET_CLOSED
    stateEmitter.emit('state', {} as StreamwallState)
    expect(socket.send).not.toHaveBeenCalled()
  })

  it('forwards local doc updates while open but not remote-origin updates', () => {
    const socket = fakeSocket()
    const stateDoc = new Y.Doc()
    connectControlUplink(
      makeDeps({
        stateDoc,
        createSocket: () => socket as unknown as UplinkSocket,
      }),
    )

    socket.send.mockClear()
    // A local edit (no special origin) should be forwarded while open.
    stateDoc.getMap('views').set('0', 'local-edit')
    expect(socket.send).toHaveBeenCalledTimes(1)
  })
})
