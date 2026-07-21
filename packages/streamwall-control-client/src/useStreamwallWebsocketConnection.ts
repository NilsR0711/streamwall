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
} from 'streamwall-shared'

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
          } else if (msg.type === 'state' || msg.type === 'state-delta') {
            let state: StreamwallState
            if (msg.type === 'state') {
              state = msg.state
              events.onConnected()
            } else {
              // Clone so the updated object triggers React renders
              state = stateDiff.clone(
                stateDiff.patch(lastStateData, msg.delta),
              ) as StreamwallState
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
