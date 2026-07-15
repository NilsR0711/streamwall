/**
 * Yjs update origin tag applied to updates received over the control
 * uplink WebSocket. Lets the uplink's own outgoing `stateDoc.on('update', ...)`
 * listener recognize updates it just received and skip echoing them straight
 * back to the same control server that sent them (issue #268).
 */
export const UPLINK_ORIGIN = 'uplink'

export function shouldForwardUpdateToUplink(origin: unknown): boolean {
  return origin !== UPLINK_ORIGIN
}
