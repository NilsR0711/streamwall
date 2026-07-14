/**
 * Yjs update origin tag applied to updates received over the local Electron
 * IPC channel from the control window. Lets the control window's own
 * outgoing `stateDoc.on('update', ...)` listener recognize updates it just
 * received and skip echoing them straight back down to the same control
 * window that sent them (issue #323).
 */
export const CONTROL_WINDOW_ORIGIN = 'controlWindow'

export function shouldForwardUpdateToControlWindow(origin: unknown): boolean {
  return origin !== CONTROL_WINDOW_ORIGIN
}
