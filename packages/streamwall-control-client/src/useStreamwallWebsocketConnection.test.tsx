import { render } from 'preact'
import { act } from 'preact/test-utils'
import type { StreamwallConnection } from 'streamwall-control-ui'
import type { ControlCommand, StreamwallState } from 'streamwall-shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'

const { FakeSocket, instances } = vi.hoisted(() => {
  type Listener = (ev: unknown) => void

  class FakeSocket {
    url: string
    options: unknown
    binaryType = ''
    closed = false
    reconnectCount = 0
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

    reconnect() {
      this.reconnectCount++
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
  fullscreenViewIdx: null,
  streamdelay: null,
  layoutPresets: [],
  favorites: [],
  dataSourceHealth: [],
}

function stateMessage(state: StreamwallState = minimalState) {
  return {
    data: JSON.stringify({ type: 'state', state }),
  }
}

function deltaMessage(delta: unknown) {
  return {
    data: JSON.stringify({ type: 'state-delta', delta }),
  }
}

/**
 * jsondiffpatch encodes a replaced scalar as `[oldValue, newValue]`. The
 * deltas below are written out rather than derived via `stateDiff.diff` so a
 * test can express an invalid target state without the differ having to build
 * a diff for one.
 */
function setCols(from: number, to: number) {
  return { config: { cols: [from, to] } }
}

const createInviteCommand: ControlCommand = {
  type: 'create-invite',
  name: 'x',
  role: 'operator',
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

  // A blip previously wiped `streamwallState` entirely on close, which
  // unmounted the grid and blanked the sidebar in streamwall-control-ui
  // (issue #37). These lock in that a reconnect only flips `isConnected`.
  describe('state across a disconnect (issue #37)', () => {
    it('keeps the last-known state instead of blanking it on close', () => {
      const { getConnection } = mount()
      const socket = instances[0]!

      act(() => {
        socket.dispatch('message', stateMessage())
      })
      expect(getConnection().role).toBe('admin')

      act(() => {
        socket.dispatch('close')
      })

      expect(getConnection().isConnected).toBe(false)
      expect(getConnection().role).toBe('admin')
      expect(getConnection().config).toEqual(minimalState.config)
    })

    it('still swaps in a fresh Yjs doc on close, to avoid merging a local-only offline edit into the next resync', () => {
      const { getConnection } = mount()
      const socket = instances[0]!
      const docBeforeClose = getConnection().stateDoc

      act(() => {
        socket.dispatch('close')
      })

      expect(getConnection().stateDoc).not.toBe(docBeforeClose)
    })
  })

  // The Yjs doc still gets reset on close (see the test above), which would
  // otherwise blank the grid's cell assignments (`sharedState.views`) for the
  // duration of a blip even though the rest of the state keeps rendering its
  // last-known content. `sharedState` should keep serving the pre-disconnect
  // snapshot until the server's resync repopulates the fresh doc (issue #283).
  describe('sharedState across a disconnect (issue #283)', () => {
    function setCellAssignment(doc: Y.Doc, idx: string, streamId: string) {
      const viewsMap = doc.getMap<Y.Map<string | undefined>>('views')
      const cellMap = new Y.Map<string | undefined>()
      cellMap.set('streamId', streamId)
      viewsMap.set(idx, cellMap)
    }

    it('keeps the last-known cell assignments instead of blanking them on close', () => {
      const { getConnection } = mount()

      act(() => {
        setCellAssignment(getConnection().stateDoc, '0', 'abc')
      })
      expect(getConnection().sharedState?.views['0']?.streamId).toBe('abc')

      const socket = instances[0]!
      act(() => {
        socket.dispatch('close')
      })

      expect(getConnection().isConnected).toBe(false)
      expect(getConnection().sharedState?.views['0']?.streamId).toBe('abc')
    })

    it('does not mutate the fresh post-close doc with the frozen snapshot', () => {
      const { getConnection } = mount()

      act(() => {
        setCellAssignment(getConnection().stateDoc, '0', 'abc')
      })

      const socket = instances[0]!
      act(() => {
        socket.dispatch('close')
      })

      const freshDoc = getConnection().stateDoc
      const viewsMap = freshDoc.getMap<Y.Map<string | undefined>>('views')
      expect(viewsMap.size).toBe(0)
    })

    it('switches back to the live sharedState once reconnected', () => {
      const { getConnection } = mount()

      act(() => {
        setCellAssignment(getConnection().stateDoc, '0', 'abc')
      })

      const socket = instances[0]!
      act(() => {
        socket.dispatch('close')
      })
      expect(getConnection().sharedState?.views['0']?.streamId).toBe('abc')

      act(() => {
        setCellAssignment(getConnection().stateDoc, '0', 'fresh')
      })
      act(() => {
        socket.dispatch('message', stateMessage())
      })

      expect(getConnection().isConnected).toBe(true)
      expect(getConnection().sharedState?.views['0']?.streamId).toBe('fresh')
    })
  })

  // Deltas are applied blind onto the last-known state, so a malformed or
  // out-of-order one used to poison `lastStateData` and compound across every
  // later delta. The patched result is validated against the same schema the
  // IPC and uplink boundaries enforce (issue #488).
  describe('state-delta validation (issue #488)', () => {
    // Every rejected delta logs; silence it so the expected warnings don't
    // look like test noise.
    let warn: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    })

    afterEach(() => {
      warn.mockRestore()
    })

    function connectedSocket() {
      const mounted = mount()
      const socket = instances[0]!
      act(() => {
        socket.dispatch('message', stateMessage())
      })
      return { ...mounted, socket }
    }

    it('applies a delta that patches into a valid state', () => {
      const { getConnection, socket } = connectedSocket()

      act(() => {
        socket.dispatch('message', deltaMessage(setCols(1, 2)))
      })

      expect(getConnection().config?.cols).toBe(2)
      expect(socket.reconnectCount).toBe(0)
    })

    it('drops a delta that patches into an invalid state and keeps the last-known state', () => {
      const { getConnection, socket } = connectedSocket()

      act(() => {
        // Below GRID_MIN, so the patched snapshot fails the schema.
        socket.dispatch('message', deltaMessage(setCols(1, 0)))
      })

      expect(getConnection().config).toEqual(minimalState.config)
      expect(warn).toHaveBeenCalled()
    })

    it('forces a resync so the client recovers instead of drifting', () => {
      const { socket } = connectedSocket()

      act(() => {
        socket.dispatch('message', deltaMessage(setCols(1, 0)))
      })

      expect(socket.reconnectCount).toBe(1)
    })

    it('ignores further deltas while desynced, so the poisoned base cannot compound', () => {
      const { getConnection, socket } = connectedSocket()

      act(() => {
        socket.dispatch('message', deltaMessage(setCols(1, 0)))
      })
      act(() => {
        socket.dispatch('message', deltaMessage(setCols(0, 3)))
      })

      expect(getConnection().config).toEqual(minimalState.config)
    })

    it('resumes applying deltas once a full state message resyncs the client', () => {
      const { getConnection, socket } = connectedSocket()

      act(() => {
        socket.dispatch('message', deltaMessage(setCols(1, 0)))
      })
      act(() => {
        socket.dispatch('message', stateMessage())
      })
      act(() => {
        socket.dispatch('message', deltaMessage(setCols(1, 4)))
      })

      expect(getConnection().config?.cols).toBe(4)
    })

    it('survives a malformed delta payload that the patcher itself rejects', () => {
      const { getConnection, socket } = connectedSocket()

      act(() => {
        // An array-diff op aimed at an object: the patcher throws on it.
        socket.dispatch(
          'message',
          deltaMessage({ config: { _t: 'a', _0: ['', 0, 0] } }),
        )
      })

      expect(getConnection().config).toEqual(minimalState.config)
      expect(socket.reconnectCount).toBe(1)
    })

    it('drops a delta that arrives before any full state, since there is no base to patch', () => {
      const { getConnection } = mount()
      const socket = instances[0]!

      act(() => {
        socket.dispatch('message', deltaMessage(setCols(1, 2)))
      })

      expect(getConnection().config).toBeUndefined()
      expect(socket.reconnectCount).toBe(1)
    })
  })

  describe('disconnectReason (issue #37)', () => {
    it('is null while connected', () => {
      const { getConnection } = mount()
      expect(getConnection().disconnectReason).toBeNull()
    })

    it('is set from an unauthorized error message instead of being dropped as unexpected', () => {
      const { getConnection } = mount()
      const socket = instances[0]!

      act(() => {
        socket.dispatch('message', {
          data: JSON.stringify({ error: 'unauthorized' }),
        })
      })

      expect(getConnection().disconnectReason).toBe('unauthorized')
    })

    it('is set from a streamwall-disconnected error message', () => {
      const { getConnection } = mount()
      const socket = instances[0]!

      act(() => {
        socket.dispatch('message', {
          data: JSON.stringify({ error: 'streamwall disconnected' }),
        })
      })

      expect(getConnection().disconnectReason).toBe('streamwall-disconnected')
    })

    it('clears on a fresh connection attempt (open) so a stale reason does not linger', () => {
      const { getConnection } = mount()
      const socket = instances[0]!

      act(() => {
        socket.dispatch('message', {
          data: JSON.stringify({ error: 'unauthorized' }),
        })
      })
      expect(getConnection().disconnectReason).toBe('unauthorized')

      act(() => {
        socket.dispatch('open')
      })

      expect(getConnection().disconnectReason).toBeNull()
    })

    it('is set from a rate-limited error message instead of being dropped as unexpected', () => {
      const { getConnection } = mount()
      const socket = instances[0]!

      act(() => {
        socket.dispatch('message', {
          data: JSON.stringify({ error: 'rate limit exceeded' }),
        })
      })

      expect(getConnection().disconnectReason).toBe('rate-limited')
    })

    it('clears once a full state message confirms a successful reconnect', () => {
      const { getConnection } = mount()
      const socket = instances[0]!

      act(() => {
        socket.dispatch('message', {
          data: JSON.stringify({ error: 'unauthorized' }),
        })
      })
      act(() => {
        socket.dispatch('message', stateMessage())
      })

      expect(getConnection().disconnectReason).toBeNull()
    })
  })
})
