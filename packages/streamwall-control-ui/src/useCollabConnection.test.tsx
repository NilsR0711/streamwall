import { render } from 'preact'
import { act } from 'preact/test-utils'
import type { ControlCommand, StreamwallState } from 'streamwall-shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { type StreamwallConnection } from './streamwallState.tsx'
import {
  type CollabTransport,
  type CollabTransportEvents,
  useCollabConnection,
} from './useCollabConnection.ts'

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

/**
 * A hand-driven transport: the test plays the peer by invoking the captured
 * `events`, pushing remote Yjs updates, and inspecting what the shared hook
 * forwarded. Deliberately dumb so every assertion pins the *shared* policy,
 * not transport plumbing.
 */
function createFakeTransport(overrides: Partial<CollabTransport> = {}) {
  const sentUpdates: Uint8Array[] = []
  const sentCommands: ControlCommand[] = []
  let events: CollabTransportEvents | undefined
  let ydocCb: ((update: Uint8Array) => void) | undefined
  const teardown = vi.fn()

  const transport: CollabTransport = {
    remoteOrigin: 'server',
    initiallyConnected: false,
    send: (msg) => {
      sentCommands.push(msg)
    },
    sendYDocUpdate: (update) => {
      sentUpdates.push(update)
    },
    subscribeYDocUpdates: (cb) => {
      ydocCb = cb
      return () => {
        ydocCb = undefined
      }
    },
    connect: (e) => {
      events = e
      return teardown
    },
    ...overrides,
  }

  return {
    transport,
    sentUpdates,
    sentCommands,
    teardown,
    getEvents: () => events!,
    pushRemote: (update: Uint8Array) => ydocCb!(update),
    isYDocSubscribed: () => ydocCb !== undefined,
  }
}

function cellAssignmentUpdate(idx: string, streamId: string): Uint8Array {
  const doc = new Y.Doc()
  const cell = new Y.Map<string | undefined>()
  cell.set('streamId', streamId)
  doc.getMap<Y.Map<string | undefined>>('views').set(idx, cell)
  return Y.encodeStateAsUpdate(doc)
}

let container: HTMLDivElement | undefined

function Harness({
  transport,
  onConnection,
}: {
  transport: CollabTransport
  onConnection: (connection: StreamwallConnection) => void
}) {
  const connection = useCollabConnection(transport)
  onConnection(connection)
  return null
}

function mount(transport: CollabTransport) {
  container = document.createElement('div')
  document.body.appendChild(container)
  let connection!: StreamwallConnection
  act(() => {
    render(
      <Harness
        transport={transport}
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

afterEach(() => {
  if (container) {
    act(() => render(null, container!))
    container.remove()
    container = undefined
  }
})

describe('useCollabConnection', () => {
  describe('Yjs origin filtering', () => {
    it('forwards a local doc edit to the transport', () => {
      const fake = createFakeTransport()
      const { getConnection } = mount(fake.transport)

      act(() => {
        getConnection()
          .stateDoc.getMap<Y.Map<string | undefined>>('views')
          .set('0', new Y.Map<string | undefined>())
      })

      expect(fake.sentUpdates).toHaveLength(1)
    })

    it('does not echo a peer-origin update back to the transport', () => {
      const fake = createFakeTransport()
      const { getConnection } = mount(fake.transport)

      act(() => {
        Y.applyUpdate(
          getConnection().stateDoc,
          cellAssignmentUpdate('0', 'abc'),
          'server',
        )
      })

      expect(fake.sentUpdates).toHaveLength(0)
    })

    it('applies a remote update into the shared doc without re-forwarding it', () => {
      const fake = createFakeTransport()
      const { getConnection } = mount(fake.transport)

      act(() => {
        fake.pushRemote(cellAssignmentUpdate('0', 'abc'))
      })

      expect(getConnection().sharedState?.views['0']?.streamId).toBe('abc')
      expect(fake.sentUpdates).toHaveLength(0)
    })
  })

  describe('connection state', () => {
    it('starts disconnected by default and connects on onConnected', () => {
      const fake = createFakeTransport()
      const { getConnection } = mount(fake.transport)
      expect(getConnection().isConnected).toBe(false)

      act(() => {
        fake.getEvents().onConnected()
      })

      expect(getConnection().isConnected).toBe(true)
    })

    it('honors an initiallyConnected transport from mount', () => {
      const fake = createFakeTransport({ initiallyConnected: true })
      const { getConnection } = mount(fake.transport)
      expect(getConnection().isConnected).toBe(true)
    })

    it('surfaces the state pushed via onState', () => {
      const fake = createFakeTransport()
      const { getConnection } = mount(fake.transport)

      act(() => {
        fake.getEvents().onState(minimalState)
      })

      expect(getConnection().role).toBe('admin')
      expect(getConnection().config).toEqual(minimalState.config)
    })

    it('sets and clears the disconnect reason', () => {
      const fake = createFakeTransport()
      const { getConnection } = mount(fake.transport)
      expect(getConnection().disconnectReason).toBeNull()

      act(() => {
        fake.getEvents().onDisconnectReason('unauthorized')
      })
      expect(getConnection().disconnectReason).toBe('unauthorized')

      act(() => {
        fake.getEvents().onDisconnectReason(null)
      })
      expect(getConnection().disconnectReason).toBeNull()
    })

    it('clears the disconnect reason on onConnected', () => {
      const fake = createFakeTransport()
      const { getConnection } = mount(fake.transport)

      act(() => {
        fake.getEvents().onDisconnectReason('unauthorized')
      })
      act(() => {
        fake.getEvents().onConnected()
      })

      expect(getConnection().disconnectReason).toBeNull()
    })

    it('delegates send to the transport', () => {
      const fake = createFakeTransport()
      const { getConnection } = mount(fake.transport)
      const command: ControlCommand = {
        type: 'create-invite',
        name: 'x',
        role: 'operator',
      }

      act(() => {
        getConnection().send(command)
      })

      expect(fake.sentCommands).toEqual([command])
    })
  })

  describe('doc-reset policy on close (issues #37 / #283)', () => {
    it('swaps in a fresh Yjs doc on close', () => {
      const fake = createFakeTransport()
      const { getConnection } = mount(fake.transport)
      const docBeforeClose = getConnection().stateDoc

      act(() => {
        fake.getEvents().onClose()
      })

      expect(getConnection().stateDoc).not.toBe(docBeforeClose)
      expect(getConnection().isConnected).toBe(false)
    })

    it('keeps serving the last-known shared state while the fresh doc is empty', () => {
      const fake = createFakeTransport()
      const { getConnection } = mount(fake.transport)

      act(() => {
        fake.pushRemote(cellAssignmentUpdate('0', 'abc'))
      })
      expect(getConnection().sharedState?.views['0']?.streamId).toBe('abc')

      act(() => {
        fake.getEvents().onClose()
      })

      expect(getConnection().sharedState?.views['0']?.streamId).toBe('abc')
      // ...but the fresh doc itself is empty, so a local-only offline edit
      // cannot survive into the next resync.
      const freshViews = getConnection().stateDoc.getMap('views')
      expect(freshViews.size).toBe(0)
    })

    it('switches back to the live shared state once reconnected', () => {
      const fake = createFakeTransport()
      const { getConnection } = mount(fake.transport)

      act(() => {
        fake.pushRemote(cellAssignmentUpdate('0', 'abc'))
      })
      act(() => {
        fake.getEvents().onClose()
      })
      expect(getConnection().sharedState?.views['0']?.streamId).toBe('abc')

      act(() => {
        fake.pushRemote(cellAssignmentUpdate('0', 'fresh'))
      })
      act(() => {
        fake.getEvents().onConnected()
        fake.getEvents().onState(minimalState)
      })

      expect(getConnection().isConnected).toBe(true)
      expect(getConnection().sharedState?.views['0']?.streamId).toBe('fresh')
    })

    it('re-wires Yjs forwarding to the fresh doc after a close', () => {
      const fake = createFakeTransport()
      const { getConnection } = mount(fake.transport)

      act(() => {
        fake.getEvents().onClose()
      })
      expect(fake.sentUpdates).toHaveLength(0)

      // A local edit on the *fresh* post-close doc must still be forwarded,
      // proving the origin-filtered update listener re-attached to it.
      act(() => {
        getConnection()
          .stateDoc.getMap<Y.Map<string | undefined>>('views')
          .set('1', new Y.Map<string | undefined>())
      })

      expect(fake.sentUpdates).toHaveLength(1)
    })
  })

  it('runs the transport teardown on unmount', () => {
    const fake = createFakeTransport()
    const { unmount } = mount(fake.transport)
    expect(fake.teardown).not.toHaveBeenCalled()

    unmount()

    expect(fake.teardown).toHaveBeenCalledTimes(1)
    expect(fake.isYDocSubscribed()).toBe(false)
  })
})
