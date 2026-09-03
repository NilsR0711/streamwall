import { render } from 'preact'
import { act } from 'preact/test-utils'
import type { StreamwallConnection } from 'streamwall-control-ui'
import {
  asViewId,
  type ControlCommand,
  type StreamwallState,
} from 'streamwall-shared'
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
    sentMessages: unknown[] = []
    // Mirrors streamwall-shared's SOCKET_OPEN (1): the existing tests all
    // assume an already-connected socket, so this defaults open.
    readyState = 1

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

    send(data: unknown) {
      this.sentMessages.push(data)
    }

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
  blockedLayerURLs: [],
  blockedLayerURLsGeneration: 0,
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

  // The control server only ever answers create-invite/delete-token; every
  // other command is forwarded to the uplink with no reply. Since
  // createErrorSurfacingSend (streamwall-control-ui) always supplies a
  // callback so it can surface `{ error }` responses, a forwarded command's
  // callback would otherwise sit in responseMap forever - not just until the
  // next close, for the lifetime of the socket (issue #745).
  describe('pending response eviction for commands the server never answers (issue #745)', () => {
    const setViewVolumeCommand: ControlCommand = {
      type: 'set-view-volume',
      viewId: asViewId(0),
      volume: 0.5,
    }

    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('does not grow responseMap forever for a forwarded command that never gets a reply', () => {
      const { getConnection } = mount()
      const socket = instances[0]!

      for (let i = 0; i < 500; i++) {
        act(() => {
          getConnection().send(setViewVolumeCommand, vi.fn())
        })
      }

      // No reply ever arrives and the socket never closes - only time
      // passes. Advance well past the eviction window.
      act(() => {
        vi.advanceTimersByTime(60_000)
      })

      // Each is evicted with a synthetic error exactly once (issue #819) - if
      // any were still pending, a later close would invoke them a second
      // time.
      const lateCallbacks = Array.from({ length: 500 }, () => vi.fn())
      for (const cb of lateCallbacks) {
        act(() => {
          getConnection().send(setViewVolumeCommand, cb)
        })
      }
      act(() => {
        vi.advanceTimersByTime(60_000)
      })
      for (const cb of lateCallbacks) {
        expect(cb).toHaveBeenCalledTimes(1)
      }

      act(() => {
        socket.dispatch('close')
      })

      for (const cb of lateCallbacks) {
        expect(cb).toHaveBeenCalledTimes(1)
      }
    })

    it('still resolves a reply that arrives before the eviction window closes', () => {
      const { getConnection } = mount()
      const socket = instances[0]!
      const cb = vi.fn()

      act(() => {
        getConnection().send(createInviteCommand, cb)
      })
      act(() => {
        vi.advanceTimersByTime(1000)
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
  })

  // PR #759 / issue #745 introduced the eviction above but deleted the
  // callback without ever invoking it, so a reply that genuinely takes
  // longer than RESPONSE_TIMEOUT_MS to arrive was dropped on the floor: the
  // operator saw neither success nor an error (issue #819, a regression of
  // the silent-failure fix from issue #35).
  describe('firing the evicted response callback instead of dropping it (issue #819)', () => {
    const setViewVolumeCommand: ControlCommand = {
      type: 'set-view-volume',
      viewId: asViewId(0),
      volume: 0.5,
    }

    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('invokes the callback with an error once the eviction window elapses, instead of dropping it', () => {
      const { getConnection } = mount()
      const cb = vi.fn()

      act(() => {
        getConnection().send(setViewVolumeCommand, cb)
      })
      act(() => {
        vi.advanceTimersByTime(5000)
      })

      expect(cb).toHaveBeenCalledTimes(1)
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(String) }),
      )
    })

    it('logs a late reply that arrives after eviction instead of silently dropping it', () => {
      const { getConnection } = mount()
      const socket = instances[0]!
      const cb = vi.fn()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      act(() => {
        getConnection().send(setViewVolumeCommand, cb)
      })
      act(() => {
        vi.advanceTimersByTime(5000)
      })
      expect(cb).toHaveBeenCalledTimes(1)

      act(() => {
        socket.dispatch('message', {
          data: JSON.stringify({ response: true, id: 0, ok: true }),
        })
      })

      // The already-evicted callback must not be invoked a second time...
      expect(cb).toHaveBeenCalledTimes(1)
      // ...but the late reply is logged rather than silently dropped.
      expect(warn).toHaveBeenCalled()
      warn.mockRestore()
    })

    it('clears the eviction timer once a reply arrives, so it never later fires a synthetic error too', () => {
      const { getConnection } = mount()
      const socket = instances[0]!
      const cb = vi.fn()

      act(() => {
        getConnection().send(createInviteCommand, cb)
      })
      act(() => {
        vi.advanceTimersByTime(1000)
      })
      act(() => {
        socket.dispatch('message', {
          data: JSON.stringify({ response: true, id: 0, tokenId: 't' }),
        })
      })
      expect(cb).toHaveBeenCalledTimes(1)

      // Advance well past every eviction window this codebase uses. If the
      // timer were not cleared, the callback would fire a second time with a
      // synthetic timeout error.
      act(() => {
        vi.advanceTimersByTime(60_000)
      })

      expect(cb).toHaveBeenCalledTimes(1)
    })

    it('gives the scrypt-backed create-invite/delete-token commands a longer eviction window than other commands', () => {
      const { getConnection } = mount()
      const volumeCb = vi.fn()
      const inviteCb = vi.fn()

      act(() => {
        getConnection().send(setViewVolumeCommand, volumeCb)
      })
      act(() => {
        getConnection().send(createInviteCommand, inviteCb)
      })

      // Past the plain 5s window: the non-scrypt command is evicted...
      act(() => {
        vi.advanceTimersByTime(5000)
      })
      expect(volumeCb).toHaveBeenCalledTimes(1)
      // ...but create-invite is still waiting.
      expect(inviteCb).not.toHaveBeenCalled()

      act(() => {
        vi.advanceTimersByTime(60_000)
      })
      expect(inviteCb).toHaveBeenCalledTimes(1)
      expect(inviteCb).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(String) }),
      )
    })
  })

  describe('sending while disconnected (issue #745)', () => {
    it('fails fast with an error instead of silently dropping the frame when the socket is not open', () => {
      const { getConnection } = mount()
      const socket = instances[0]!
      socket.readyState = 3 // CLOSED
      const cb = vi.fn()

      act(() => {
        getConnection().send(createInviteCommand, cb)
      })

      expect(socket.sentMessages).toHaveLength(0)
      expect(cb).toHaveBeenCalledTimes(1)
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(String) }),
      )
    })

    it('still sends normally once the socket is open', () => {
      const { getConnection } = mount()
      const socket = instances[0]!
      const cb = vi.fn()

      act(() => {
        getConnection().send(createInviteCommand, cb)
      })

      expect(socket.sentMessages).toHaveLength(1)
      expect(cb).not.toHaveBeenCalled()
    })
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

    // A string where a nested delta belongs makes jsondiffpatch allocate
    // until the heap dies, so the payload has to be rejected before `patch`
    // ever sees it (issue #539). These deltas are written out literally: a
    // rejected one must never reach the patcher, not even in a test.
    it('drops a string-valued delta property before the patcher hangs on it', () => {
      const { getConnection, socket } = connectedSocket()

      act(() => {
        socket.dispatch('message', deltaMessage({ config: 'not-a-delta' }))
      })

      expect(getConnection().config).toEqual(minimalState.config)
      expect(socket.reconnectCount).toBe(1)
      expect(warn).toHaveBeenCalled()
    })

    it('drops a number-valued delta property', () => {
      const { getConnection, socket } = connectedSocket()

      act(() => {
        socket.dispatch('message', deltaMessage({ config: 42 }))
      })

      expect(getConnection().config).toEqual(minimalState.config)
      expect(socket.reconnectCount).toBe(1)
    })

    it('drops a delta that is not an object at all', () => {
      const { getConnection, socket } = connectedSocket()

      act(() => {
        socket.dispatch('message', deltaMessage('nope'))
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
