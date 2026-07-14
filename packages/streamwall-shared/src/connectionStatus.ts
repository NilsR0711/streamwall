/**
 * Fine-grained lifecycle status for a client's websocket link to the control
 * server, distinguishing *why* the link isn't up so the UI can show a
 * specific reason instead of a single generic "connecting..." spinner for
 * every failure mode (issue #37).
 */
export type ConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'unauthorized'
  | 'server-down'

export type ConnectionStatusEvent =
  | { type: 'state-received' }
  | { type: 'closed' }
  | { type: 'unauthorized' }
  | { type: 'server-down' }

/**
 * Pure transition function for `ConnectionStatus`, kept side-effect free so
 * the reconnect/error-message handling can be unit-tested without a real (or
 * mocked) WebSocket.
 */
export function nextConnectionStatus(
  current: ConnectionStatus,
  event: ConnectionStatusEvent,
): ConnectionStatus {
  switch (event.type) {
    case 'state-received':
      return 'connected'
    case 'unauthorized':
      return 'unauthorized'
    case 'server-down':
      return 'server-down'
    case 'closed':
      // Only a link that was actually up degrades to "reconnecting" - the
      // more specific 'unauthorized'/'server-down' reasons (or the initial
      // "still connecting") shouldn't be overwritten by the close event
      // that immediately follows them.
      return current === 'connected' ? 'reconnecting' : current
  }
}
