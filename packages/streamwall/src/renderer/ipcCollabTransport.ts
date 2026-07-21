import { type CollabTransport } from 'streamwall-control-ui'
import { type StreamwallControlGlobal } from '../preload/controlPreload'

/**
 * Electron IPC adapter: the transport-specific half of the collab wiring the
 * shared `useCollabConnection` hook consumes. The main process is always
 * reachable, so this transport is trivially "connected" and never closes -
 * the shared hook's reconnect/doc-reset policy simply no-ops for it. The Yjs
 * origin filter and connection-state assembly are shared and live in
 * `useCollabConnection` (issue #396).
 */
export function createIpcCollabTransport(
  control: StreamwallControlGlobal,
): CollabTransport {
  return {
    remoteOrigin: 'app',
    // The main process is in-process and always up: there is no link to
    // establish, so the connection is live from the first render (no
    // "connecting" flash), and `onClose` never fires.
    initiallyConnected: true,

    send: async (msg, cb) => {
      const resp = await control.invokeCommand(msg)
      cb?.(resp)
    },

    sendYDocUpdate: (update) => control.updateYDoc(update),

    subscribeYDocUpdates: (cb) => control.onYDoc(cb),

    connect: (events) => {
      const unsubscribe = control.onState(events.onState)
      events.onConnected()
      // Ask the main process for the initial state + Yjs snapshot now that the
      // listeners are wired.
      control.load()
      return unsubscribe
    },
  }
}
