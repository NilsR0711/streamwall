import { render } from 'preact'
import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import ReconnectingWebSocket from 'reconnecting-websocket'
import {
  type CollabData,
  ControlUI,
  GlobalStyle,
  type StreamwallConnection,
  useStreamwallState,
  useYDoc,
} from 'streamwall-control-ui'
import {
  type ConnectionStatus,
  type ControlCommand,
  isSocketOpen,
  nextConnectionStatus,
  stateDiff,
  type StreamwallState,
} from 'streamwall-shared'
import * as Y from 'yjs'

function useStreamwallWebsocketConnection(
  wsEndpoint: string,
): StreamwallConnection {
  const wsRef = useRef<{
    ws: ReconnectingWebSocket
    msgId: number
    responseMap: Map<number, (msg: object) => void>
  }>()
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>('connecting')
  const {
    docValue: sharedState,
    doc: stateDoc,
    setDoc: setStateDoc,
    undoManager,
  } = useYDoc<CollabData>(['views'], 'server')
  const [streamwallState, setStreamwallState] = useState<StreamwallState>()
  const appState = useStreamwallState(streamwallState)

  useEffect(() => {
    let lastStateData: StreamwallState | undefined
    const ws = new ReconnectingWebSocket(wsEndpoint, [], {
      maxReconnectionDelay: 5000,
      minReconnectionDelay: 1000 + Math.random() * 500,
      reconnectionDelayGrowFactor: 1.1,
      // The server pushes a full 'state' message (and full Yjs doc) as soon
      // as a client (re)connects, so anything queued while disconnected is
      // stale by the time it could be delivered. Disable the library's
      // default unbounded queue rather than let it buffer indefinitely while
      // the control server is unreachable.
      maxEnqueuedMessages: 0,
    })
    ws.binaryType = 'arraybuffer'
    ws.addEventListener('open', () => {
      // Discard any local Yjs edits that never reached the server (sendUpdate
      // below silently drops sends made while the socket is closed) so the
      // full-doc snapshot the server sends on every (re)connect merges into a
      // clean doc instead of racing an edit the server never learned about.
      setStateDoc(new Y.Doc())
    })
    ws.addEventListener('close', () => {
      setConnectionStatus((prev) =>
        nextConnectionStatus(prev, { type: 'closed' }),
      )
    })
    ws.addEventListener('message', (ev) => {
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
          setConnectionStatus((prev) =>
            nextConnectionStatus(prev, { type: 'state-received' }),
          )
        } else {
          // Clone so updated object triggers React renders
          state = stateDiff.clone(
            stateDiff.patch(lastStateData, msg.delta),
          ) as StreamwallState
        }
        lastStateData = state
        setStreamwallState(state)
      } else if (msg.error === 'unauthorized') {
        setConnectionStatus((prev) =>
          nextConnectionStatus(prev, { type: 'unauthorized' }),
        )
        // The server won't accept this session on a retry - stop
        // reconnecting so the UI can show a stable "reload / request a new
        // invite" message instead of a spinner that will never resolve.
        ws.close()
      } else if (msg.error === 'streamwall disconnected') {
        setConnectionStatus((prev) =>
          nextConnectionStatus(prev, { type: 'server-down' }),
        )
      } else {
        console.warn('unexpected ws message', msg)
      }
    })
    wsRef.current = { ws, msgId: 0, responseMap: new Map() }
  }, [setStateDoc, wsEndpoint])

  const send = useCallback(
    (msg: ControlCommand, cb?: (msg: unknown) => void) => {
      if (!wsRef.current) {
        throw new Error('Websocket not initialized')
      }
      const { ws, msgId, responseMap } = wsRef.current
      ws.send(
        JSON.stringify({
          ...msg,
          id: msgId,
        }),
      )
      if (cb) {
        responseMap.set(msgId, cb)
      }
      wsRef.current.msgId++
    },
    [],
  )

  useEffect(() => {
    if (!wsRef.current) {
      throw new Error('Websocket not initialized')
    }
    const { ws } = wsRef.current

    function sendUpdate(update: Uint8Array, origin: string) {
      if (origin === 'server') {
        return
      }
      const { ws } = wsRef.current ?? {}
      if (!ws || !isSocketOpen(ws)) {
        return
      }
      ws.send(update)
    }

    function receiveUpdate(ev: MessageEvent) {
      if (!(ev.data instanceof ArrayBuffer)) {
        return
      }
      Y.applyUpdate(stateDoc, new Uint8Array(ev.data), 'server')
    }

    stateDoc.on('update', sendUpdate)
    ws.addEventListener('message', receiveUpdate)
    return () => {
      stateDoc.off('update', sendUpdate)
      ws.removeEventListener('message', receiveUpdate)
    }
  }, [stateDoc])

  return {
    ...appState,
    connectionStatus,
    send,
    sharedState,
    stateDoc,
    undoManager,
  }
}

function App() {
  const { BASE_URL } = import.meta.env

  const connection = useStreamwallWebsocketConnection(
    (BASE_URL === '/' ? `ws://${location.host}` : BASE_URL) + '/client/ws',
  )

  return (
    <>
      <GlobalStyle />
      <ControlUI connection={connection} />
    </>
  )
}

render(<App />, document.body)
