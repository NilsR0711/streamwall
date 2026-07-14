import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import ReconnectingWebSocket from 'reconnecting-websocket'
import {
  type CollabData,
  type StreamwallConnection,
  useStreamwallState,
  useYDoc,
} from 'streamwall-control-ui'
import {
  type ControlCommand,
  isSocketOpen,
  stateDiff,
  type StreamwallState,
} from 'streamwall-shared'
import * as Y from 'yjs'

export function useStreamwallWebsocketConnection(
  wsEndpoint: string,
): StreamwallConnection {
  const wsRef = useRef<{
    ws: ReconnectingWebSocket
    msgId: number
    responseMap: Map<number, (msg: object) => void>
  }>()
  const [isConnected, setIsConnected] = useState(false)
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

    function handleClose() {
      setStreamwallState(undefined)
      lastStateData = undefined
      setStateDoc(new Y.Doc())
      setIsConnected(false)
      // Any command awaiting a response will never hear back from this
      // socket - reject the callers instead of leaking their callbacks in
      // responseMap forever.
      const { responseMap } = wsRef.current ?? {}
      if (responseMap) {
        for (const responseCb of responseMap.values()) {
          responseCb({ response: true, error: 'Connection closed' })
        }
        responseMap.clear()
      }
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
          setIsConnected(true)
        } else {
          // Clone so updated object triggers React renders
          state = stateDiff.clone(
            stateDiff.patch(lastStateData, msg.delta),
          ) as StreamwallState
        }
        lastStateData = state
        setStreamwallState(state)
      } else {
        console.warn('unexpected ws message', msg)
      }
    }

    ws.addEventListener('close', handleClose)
    ws.addEventListener('message', handleMessage)
    wsRef.current = { ws, msgId: 0, responseMap: new Map() }

    return () => {
      ws.removeEventListener('close', handleClose)
      ws.removeEventListener('message', handleMessage)
      ws.close()
      wsRef.current = undefined
    }
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
    isConnected,
    send,
    sharedState,
    stateDoc,
    undoManager,
  }
}
