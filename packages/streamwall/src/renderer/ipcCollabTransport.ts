import { type CollabTransport } from 'streamwall-control-ui'
import { streamwallStateSchema } from 'streamwall-shared'
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
      const unsubscribe = control.onState((state) => {
        // The main process is trusted, but it is also the one component that
        // can regress: a partial or malformed snapshot pushed during a bug or
        // a mid-upgrade schema drift would otherwise render as a garbage grid
        // (issue #409). Validating here mirrors the uplink boundary the
        // control server guards with the same schema (issue #387), so both
        // consumers of `StreamwallState` enforce the same contract.
        const result = streamwallStateSchema.safeParse(state)
        if (!result.success) {
          console.warn(
            'Ignored invalid Streamwall state from main process:',
            result.error.issues[0]?.message,
          )
          // Dropping the update leaves the shared hook on the last valid
          // snapshot, which keeps the UI usable instead of blanking it.
          return
        }
        // Forward the original object rather than the parsed copy: validation
        // is a gate here, not a transform, so fields the schema does not model
        // survive the hop.
        events.onState(state)
      })
      events.onConnected()
      // Ask the main process for the initial state + Yjs snapshot now that the
      // listeners are wired.
      control.load()
      return unsubscribe
    },
  }
}
