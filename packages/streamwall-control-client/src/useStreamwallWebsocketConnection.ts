import type { Delta } from 'jsondiffpatch'
import { useMemo, useRef } from 'preact/hooks'
import ReconnectingWebSocket from 'reconnecting-websocket'
import {
  type CollabTransport,
  type StreamwallConnection,
  useCollabConnection,
} from 'streamwall-control-ui'
import {
  isSocketOpen,
  parseDisconnectReason,
  stateDiff,
  type StreamwallState,
  streamwallStateSchema,
} from 'streamwall-shared'

/**
 * Applies a server `state-delta` to the last-known snapshot and gates the
 * result on the same schema the IPC and uplink boundaries enforce (issues #409
 * / #387). Unlike a full snapshot, a bad delta is not a one-off: the patched
 * object becomes the base for every later delta, so an unchecked one keeps
 * compounding. Returns `undefined` when the delta cannot be trusted.
 *
 * The base is cloned before patching because `stateDiff.patch` mutates its
 * target in place - patching `lastStateData` directly would corrupt it even
 * when the caller then discards the result (issue #488).
 */
function patchState(
  lastStateData: StreamwallState | undefined,
  delta: unknown,
): StreamwallState | undefined {
  if (lastStateData === undefined) {
    console.warn('Ignored Streamwall state delta received before a snapshot')
    return undefined
  }
  let patched: unknown
  try {
    // Cloning also gives the updated object a fresh identity, which is what
    // triggers React renders downstream. The cast is deliberate: the payload
    // came off the wire unvalidated, and `patch` has no total signature for
    // untrusted input - hence the catch below.
    patched = stateDiff.patch(stateDiff.clone(lastStateData), delta as Delta)
  } catch (err) {
    console.warn('Ignored unpatchable Streamwall state delta:', err)
    return undefined
  }
  const result = streamwallStateSchema.safeParse(patched)
  if (!result.success) {
    console.warn(
      'Ignored Streamwall state delta patching into an invalid state:',
      result.error.issues[0]?.message,
    )
    return undefined
  }
  // Return the patched object rather than the parsed copy: validation is a
  // gate here, not a transform, so fields the schema does not model survive.
  return patched as StreamwallState
}

interface WsRef {
  ws: ReconnectingWebSocket
  msgId: number
  responseMap: Map<number, (msg: object) => void>
}

/**
 * WebSocket adapter: the transport-specific half of the collab wiring the
 * shared `useCollabConnection` hook consumes. It owns only what is unique to
 * the socket - the reconnect policy, the JSON message protocol (responses,
 * `state`/`state-delta`, error reasons), and binary Yjs framing. The Yjs
 * origin filter, doc-reset-on-disconnect, and connection-state assembly are
 * shared and live in `useCollabConnection` (issue #396).
 */
function useWebsocketCollabTransport(wsEndpoint: string): CollabTransport {
  const wsRef = useRef<WsRef>()

  return useMemo<CollabTransport>(
    () => ({
      remoteOrigin: 'server',
      initiallyConnected: false,

      send(msg, cb) {
        if (!wsRef.current) {
          throw new Error('Websocket not initialized')
        }
        const { ws, msgId, responseMap } = wsRef.current
        ws.send(JSON.stringify({ ...msg, id: msgId }))
        if (cb) {
          responseMap.set(msgId, cb)
        }
        wsRef.current.msgId++
      },

      sendYDocUpdate(update) {
        const { ws } = wsRef.current ?? {}
        if (!ws || !isSocketOpen(ws)) {
          return
        }
        ws.send(update)
      },

      subscribeYDocUpdates(cb) {
        const ws = wsRef.current?.ws
        if (!ws) {
          return () => {}
        }
        function receiveUpdate(ev: MessageEvent) {
          if (!(ev.data instanceof ArrayBuffer)) {
            return
          }
          cb(new Uint8Array(ev.data))
        }
        ws.addEventListener('message', receiveUpdate)
        return () => {
          ws.removeEventListener('message', receiveUpdate)
        }
      },

      connect(events) {
        let lastStateData: StreamwallState | undefined
        // Set once a delta is rejected: the server has already advanced past
        // what we last accepted, so every following delta is a diff against a
        // state we do not have. Further deltas are dropped until a full
        // snapshot resyncs us.
        let desynced = false
        const ws = new ReconnectingWebSocket(wsEndpoint, [], {
          maxReconnectionDelay: 5000,
          minReconnectionDelay: 1000 + Math.random() * 500,
          reconnectionDelayGrowFactor: 1.1,
          // The server pushes a full 'state' message (and full Yjs doc) as
          // soon as a client (re)connects, so anything queued while
          // disconnected is stale by the time it could be delivered. Disable
          // the library's default unbounded queue rather than let it buffer
          // indefinitely while the control server is unreachable.
          maxEnqueuedMessages: 0,
        })
        ws.binaryType = 'arraybuffer'

        function handleClose() {
          // The shared doc-reset policy fires first (snapshot + fresh doc);
          // then reject any command still awaiting a response - it will never
          // hear back from this socket, so its caller must not leak in
          // responseMap forever.
          events.onClose()
          const { responseMap } = wsRef.current ?? {}
          if (responseMap) {
            for (const responseCb of responseMap.values()) {
              responseCb({ response: true, error: 'Connection closed' })
            }
            responseMap.clear()
          }
        }

        function handleOpen() {
          // A fresh connection attempt may still fail (e.g. an expired
          // session); clear the previous reason optimistically so a stale
          // "unauthorized" banner doesn't linger if this attempt instead keeps
          // retrying for an unrelated reason. The server's next message sets
          // it again if the same failure recurs.
          events.onDisconnectReason(null)
        }

        function handleMessage(ev: MessageEvent) {
          if (ev.data instanceof ArrayBuffer) {
            return
          }
          const msg = JSON.parse(ev.data)
          if (msg.response && wsRef.current != null) {
            const { responseMap } = wsRef.current
            const responseCb = responseMap.get(msg.id)
            if (responseCb) {
              responseMap.delete(msg.id)
              responseCb(msg)
            }
          } else if (msg.type === 'state') {
            desynced = false
            lastStateData = msg.state
            events.onConnected()
            events.onState(msg.state)
          } else if (msg.type === 'state-delta') {
            if (desynced) {
              return
            }
            const state = patchState(lastStateData, msg.delta)
            if (!state) {
              // Keep `lastStateData` on the last snapshot we trust and ask the
              // server for a fresh one: it only pushes a full `state` on
              // (re)connect, so reconnecting is how a client resyncs.
              desynced = true
              ws.reconnect()
              return
            }
            lastStateData = state
            events.onState(state)
          } else {
            const reason = parseDisconnectReason(msg)
            if (reason) {
              events.onDisconnectReason(reason)
            } else {
              console.warn('unexpected ws message', msg)
            }
          }
        }

        ws.addEventListener('close', handleClose)
        ws.addEventListener('open', handleOpen)
        ws.addEventListener('message', handleMessage)
        wsRef.current = { ws, msgId: 0, responseMap: new Map() }

        return () => {
          ws.removeEventListener('close', handleClose)
          ws.removeEventListener('open', handleOpen)
          ws.removeEventListener('message', handleMessage)
          ws.close()
          wsRef.current = undefined
        }
      },
    }),
    [wsEndpoint],
  )
}

export function useStreamwallWebsocketConnection(
  wsEndpoint: string,
): StreamwallConnection {
  const transport = useWebsocketCollabTransport(wsEndpoint)
  return useCollabConnection(transport)
}
