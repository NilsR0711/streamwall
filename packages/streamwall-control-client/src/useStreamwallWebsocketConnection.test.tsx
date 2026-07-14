import { render } from 'preact'
import { act } from 'preact/test-utils'
import type { StreamwallConnection } from 'streamwall-control-ui'
import type { ControlCommand, StreamwallState } from 'streamwall-shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { FakeSocket, instances } = vi.hoisted(() => {
  type Listener = (ev: unknown) => void

  class FakeSocket {
    url: string
    options: unknown
    binaryType = ''
    closed = false
    listeners = new Map<string, Set<Listener>>()

    constructor(url: string, _protocols: unknown, options: unknown) {
      this.url = url
      this.options = options
      instances.push(this)
    }

    addEventListener(type: string, cb: Listener) {
      if (!this.listeners.has(type)) {
        this.listeners.set(type, new Set())
      }
      this.listeners.get(type)!.add(cb)
    }

    removeEventListener(type: string, cb: Listener) {
      this.listeners.get(type)?.delete(cb)
    }

    send() {}

    close() {
      this.closed = true
    }

    dispatch(type: string, ev: unknown = {}) {
      for (const cb of [...(this.listeners.get(type) ?? [])]) {
        cb(ev)
      }
    }
  }

  const instances: InstanceType<typeof FakeSocket>[] = []
  return { FakeSocket, instances }
})

vi.mock('reconnecting-websocket', () => ({ default: FakeSocket }))

import { useStreamwallWebsocketConnection } from './useStreamwallWebsocketConnection.ts'

const minimalState: StreamwallState = {
  identity: { role: 'admin' },
  config: {
    cols: 1,
    rows: 1,
    width: 100,
    height: 100,
    frameless: false,
    fullscreen: false,
    activeColor: '#fff',
    backgroundColor: '#000',
  },
  streams: [],
  customStreams: [],
  views: [],
  streamdelay: null,
  layoutPresets: [],
  dataSourceHealth: [],
}

function stateMessage() {
  return {
    data: JSON.stringify({ type: 'state', state: minimalState }),
  }
}

const createInviteCommand: ControlCommand = {
  type: 'create-invite',
  name: 'x',
  role: 'viewer',
}

function Harness({
  endpoint,
  onConnection,
}: {
  endpoint: string
  onConnection: (connection: StreamwallConnection) => void
}) {
  const connection = useStreamwallWebsocketConnection(endpoint)
  onConnection(connection)
  return null
}

let container: HTMLDivElement | undefined

function mount(endpoint = 'ws://example.test/client/ws') {
  container = document.createElement('div')
  document.body.appendChild(container)
  let connection!: StreamwallConnection
  act(() => {
    render(
      <Harness
        endpoint={endpoint}
        onConnection={(c) => {
          connection = c
        }}
      />,
      container!,
    )
  })
  return {
    getConnection: () => connection,
    unmount: () => act(() => render(null, container!)),
  }
}

beforeEach(() => {
  instances.length = 0
})

afterEach(() => {
  if (container) {
    act(() => render(null, container!))
    container.remove()
    container = undefined
  }
})

describe('useStreamwallWebsocketConnection', () => {
  it('closes the socket and detaches its listeners when the component unmounts', () => {
    const { unmount } = mount()
    expect(instances).toHaveLength(1)
    const socket = instances[0]!
    expect(socket.closed).toBe(false)
    expect(socket.listeners.get('close')?.size).toBeGreaterThan(0)
    expect(socket.listeners.get('message')?.size).toBeGreaterThan(0)

    unmount()

    expect(socket.closed).toBe(true)
    expect(socket.listeners.get('close')?.size).toBe(0)
    expect(socket.listeners.get('message')?.size).toBe(0)
  })

  it('resolves a pending response callback normally when the server replies', () => {
    const { getConnection } = mount()
    const socket = instances[0]!
    const cb = vi.fn()

    act(() => {
      getConnection().send(createInviteCommand, cb)
    })
    act(() => {
      socket.dispatch('message', {
        data: JSON.stringify({ response: true, id: 0, tokenId: 't' }),
      })
    })

    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith(
      expect.objectContaining({ response: true, id: 0, tokenId: 't' }),
    )
  })

  it('rejects pending response callbacks with an error when the socket closes', () => {
    const { getConnection } = mount()
    const socket = instances[0]!
    const cb = vi.fn()

    act(() => {
      getConnection().send(createInviteCommand, cb)
    })
    act(() => {
      socket.dispatch('close')
    })

    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(String) }),
    )
  })

  it('clears the response map on close so a stale, late server reply cannot double-invoke the callback', () => {
    const { getConnection } = mount()
    const socket = instances[0]!
    const cb = vi.fn()

    act(() => {
      getConnection().send(createInviteCommand, cb)
    })
    act(() => {
      socket.dispatch('close')
    })
    expect(cb).toHaveBeenCalledTimes(1)

    act(() => {
      socket.dispatch('message', {
        data: JSON.stringify({ response: true, id: 0, tokenId: 'late' }),
      })
    })

    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('marks the connection open on a full state message', () => {
    const { getConnection } = mount()
    const socket = instances[0]!

    act(() => {
      socket.dispatch('message', stateMessage())
    })

    expect(getConnection().isConnected).toBe(true)
  })
})
