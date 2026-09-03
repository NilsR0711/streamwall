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
  stateDeltaSchema,
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
 *
 * The delta itself is validated first: some malformed shapes - a string where
 * a nested delta belongs - make `patch` allocate until the heap dies, which no
 * `try`/`catch` around it can contain (issue #539).
 */
function patchState(
  lastStateData: StreamwallState | undefined,
  delta: unknown,
): StreamwallState | undefined {
  if (lastStateData === undefined) {
    console.warn('Ignored Streamwall state delta received before a snapshot')
    return undefined
  }
  const deltaResult = stateDeltaSchema.safeParse(delta)
  if (!deltaResult.success) {
    console.warn('Ignored malformed Streamwall state delta')
    return undefined
  }
  let patched: unknown
  try {
    // Cloning also gives the updated object a fresh identity, which is what
    // triggers React renders downstream. A well-formed delta can still fail to
    // apply against this particular base - hence the catch below.
    patched = stateDiff.patch(stateDiff.clone(lastStateData), deltaResult.data)
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

/** A callback awaiting a response, plus the eviction timer guarding it. */
interface PendingResponse {
  cb: (msg: object) => void
  /** Cleared once the reply arrives, so eviction never fires afterward. */
  timeoutId: ReturnType<typeof setTimeout>
}

interface WsRef {
  ws: ReconnectingWebSocket
  msgId: number
  responseMap: Map<number, PendingResponse>
}

/**
 * How long a pending response callback is kept before being evicted
 * unanswered. The control server only replies to a couple of request/
 * response commands; every other command is forwarded with no reply, so this
 * bounds `responseMap`'s lifetime for those instead of leaking until the next
 * close (issue #745). A few seconds is ample for a same-machine/LAN control
 * server to answer the commands that do reply.
 */
const RESPONSE_TIMEOUT_MS = 5000

/**
 * Eviction window for the two commands the server answers by deriving a
 * scrypt hash (`create-invite`, `delete-token`): tens of milliseconds of
 * libuv-threadpool work each (issues #735/#799) that can queue behind other
 * derivations on a loaded or modest self-hosted box. `RESPONSE_TIMEOUT_MS` is
 * comfortably enough for every other command, which the control server never
 * derives anything for (issue #819).
 */
const CRYPTO_RESPONSE_TIMEOUT_MS = 15000

function responseTimeoutMsFor(commandType: string): number {
  return commandType === 'create-invite' || commandType === 'delete-token'
    ? CRYPTO_RESPONSE_TIMEOUT_MS
    : RESPONSE_TIMEOUT_MS
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
        if (!isSocketOpen(ws)) {
          // maxEnqueuedMessages: 0 means the frame would just be dropped
          // silently; fail the caller's callback immediately instead of
          // leaving it pending forever (issue #745).
          cb?.({ response: true, error: 'Not connected' })
          return
        }
        ws.send(JSON.stringify({ ...msg, id: msgId }))
        if (cb) {
          // The control server only ever answers a handful of commands
          // (create-invite, delete-token); every other command is forwarded
          // to the uplink with no reply. createErrorSurfacingSend always
          // supplies a callback (to surface `{ error }` responses), so
          // without this eviction a forwarded command's entry - and the
          // closure it holds - would sit in responseMap for the lifetime of
          // the socket instead of just until the next close (issue #745).
          //
          // Eviction fires the callback with a synthetic error rather than
          // just deleting the entry: PR #759 introduced this timer but left
          // the callback uninvoked, so a reply that genuinely took longer
          // than the window arrived to no callback and was silently dropped
          // - the operator saw neither success nor an error (issue #819).
          const timeoutId = setTimeout(() => {
            const pending = responseMap.get(msgId)
            if (pending) {
              responseMap.delete(msgId)
              pending.cb({
                response: true,
                error: 'No response from the server',
              })
            }
          }, responseTimeoutMsFor(msg.type))
          responseMap.set(msgId, { cb, timeoutId })
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
            for (const { cb: responseCb, timeoutId } of responseMap.values()) {
              clearTimeout(timeoutId)
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
            const pending = responseMap.get(msg.id)
            if (pending) {
              responseMap.delete(msg.id)
              clearTimeout(pending.timeoutId)
              pending.cb(msg)
            } else {
              // No pending callback for this id: either it was already
              // evicted with a synthetic timeout error (issue #819) and the
              // caller has moved on, or the id is otherwise stale. Either
              // way, log the late reply instead of silently dropping it.
              console.warn(
                'Ignored a Streamwall response with no pending callback:',
                msg,
              )
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
