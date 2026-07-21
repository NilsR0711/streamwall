import { useEffect, useRef, useState } from 'preact/hooks'
import { type DisconnectReason, type StreamwallState } from 'streamwall-shared'
import * as Y from 'yjs'
import { type CollabData, collabDataSchema } from './collabData.ts'
import {
  type StreamwallConnection,
  useStreamwallState,
} from './streamwallState.tsx'
import { useYDoc } from './useYDoc.ts'

/**
 * Lifecycle callbacks a `CollabTransport` invokes to drive the shared
 * connection state. Each maps to exactly one policy the shared hook owns, so
 * every transport gets identical reconnect and origin behaviour (issue #396).
 */
export interface CollabTransportEvents {
  /** A full state snapshot pushed by the peer (initial load or resync). */
  onState(state: StreamwallState): void
  /**
   * The collab link is live and carrying a fresh full state. Marks the
   * connection connected and clears any lingering disconnect reason.
   */
  onConnected(): void
  /**
   * The collab link dropped. Triggers the shared doc-reset policy: snapshot
   * the last-known shared state for offline rendering, then swap in a fresh
   * Yjs doc so a local-only offline edit cannot merge into the next resync
   * (issues #37 / #283).
   */
  onClose(): void
  /**
   * The peer stated why it is (or is about to be) disconnected, without a
   * full close - e.g. an `unauthorized` error, or clearing the reason
   * (`null`) on a fresh connection attempt.
   */
  onDisconnectReason(reason: DisconnectReason | null): void
}

/**
 * A thin, transport-specific adapter consumed by {@link useCollabConnection}.
 * It owns only what differs between transports (how bytes move); the shared
 * hook owns the Yjs origin rules, doc-reset policy, and connection-state
 * assembly. Implement one of these to add a new client (e.g. Tauri, an
 * embedded webview) without reimplementing the collab wiring.
 */
export interface CollabTransport {
  /**
   * Origin tag for Yjs updates that arrived from the peer. Local edits carry
   * any other origin and get forwarded back to the peer; peer-origin updates
   * are applied with this tag and never echoed, breaking the update loop.
   */
  remoteOrigin: string
  /**
   * Whether the transport is connected before any peer message arrives. `true`
   * for an always-on transport (Electron IPC); `false` for one that must first
   * establish a link (WebSocket).
   */
  initiallyConnected?: boolean
  /** Send a control command to the peer, optionally awaiting its response. */
  send: StreamwallConnection['send']
  /** Forward a local Yjs update to the peer. */
  sendYDocUpdate(update: Uint8Array): void
  /** Subscribe to Yjs updates arriving from the peer; returns an unsubscribe. */
  subscribeYDocUpdates(cb: (update: Uint8Array) => void): () => void
  /**
   * Establish the connection and wire peer messages to `events`. Returns a
   * teardown run on unmount. Called once per transport instance and never
   * re-run on a doc reset, so the transport outlives reconnect blips.
   */
  connect(events: CollabTransportEvents): () => void
}

/**
 * Turns a {@link CollabTransport} into a `StreamwallConnection` for
 * `<ControlUI>`. This is the single home for the collab wiring both the
 * Electron IPC renderer and the standalone WebSocket client used to
 * reimplement independently (issue #396): the Yjs origin filter, the
 * doc-reset-on-disconnect policy with last-known-state fallback, and the
 * connection-state assembly all live here.
 */
export function useCollabConnection(
  transport: CollabTransport,
): StreamwallConnection {
  const { remoteOrigin } = transport
  const {
    docValue: sharedState,
    doc: stateDoc,
    setDoc: setStateDoc,
    undoManager,
  } = useYDoc<CollabData>(['views'], collabDataSchema, remoteOrigin)
  const [streamwallState, setStreamwallState] = useState<StreamwallState>()
  const [isConnected, setIsConnected] = useState(
    transport.initiallyConnected ?? false,
  )
  const [disconnectReason, setDisconnectReason] =
    useState<DisconnectReason | null>(null)
  const appState = useStreamwallState(streamwallState)

  // Kept in sync with `sharedState` on every render so `onClose` (which fires
  // from the transport, outside React's render cycle) can always read the
  // value from just before the disconnect.
  const sharedStateRef = useRef(sharedState)
  sharedStateRef.current = sharedState
  // `stateDoc` is swapped for a fresh, empty doc on every disconnect, which
  // would otherwise blank the grid's cell assignments (`sharedState.views`)
  // for the duration of a blip. This snapshot lets the connection keep serving
  // the pre-disconnect data for rendering while offline; it's never written
  // back into `stateDoc`, so it can't reintroduce the divergence the reset
  // avoids (issue #283).
  const lastKnownSharedStateRef = useRef<CollabData | undefined>(undefined)

  // Connection lifecycle. Deliberately not keyed on `stateDoc`: a reconnect
  // resets the doc, but the transport itself must survive that so the socket
  // is not torn down and recreated on every blip.
  useEffect(() => {
    const events: CollabTransportEvents = {
      onState(state) {
        setStreamwallState(state)
      },
      onConnected() {
        setIsConnected(true)
        setDisconnectReason(null)
      },
      onClose() {
        lastKnownSharedStateRef.current = sharedStateRef.current
        setStateDoc(new Y.Doc())
        setIsConnected(false)
      },
      onDisconnectReason(reason) {
        setDisconnectReason(reason)
      },
    }
    return transport.connect(events)
    // The setters and `setStateDoc` are stable; `transport` is stable per
    // adapter (recreated only when its identity - e.g. the ws endpoint -
    // changes). Reruns only on a genuine transport swap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transport])

  // Yjs sync, re-subscribed per doc so a fresh post-disconnect doc is wired up
  // too. Single home for the origin rule shared by all transports: never echo
  // a peer-origin update back, and tag incoming peer updates with
  // `remoteOrigin` so they don't loop.
  useEffect(() => {
    function sendUpdate(update: Uint8Array, origin: unknown) {
      if (origin === remoteOrigin) {
        return
      }
      transport.sendYDocUpdate(update)
    }

    stateDoc.on('update', sendUpdate)
    const unsubscribe = transport.subscribeYDocUpdates((update) => {
      Y.applyUpdate(stateDoc, update, remoteOrigin)
    })
    return () => {
      stateDoc.off('update', sendUpdate)
      unsubscribe()
    }
  }, [stateDoc, transport, remoteOrigin])

  return {
    ...appState,
    isConnected,
    disconnectReason,
    send: transport.send,
    sharedState: isConnected
      ? sharedState
      : (lastKnownSharedStateRef.current ?? sharedState),
    stateDoc,
    undoManager,
  }
}
