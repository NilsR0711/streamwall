import { parseUplinkError, type UplinkErrorReason } from 'streamwall-shared'

/**
 * Human-readable explanation logged when the control server refuses the uplink
 * connection. These `{error: '...'}` messages carry no command `type`, so
 * without this they would otherwise be logged by `onCommand` as a misleading
 * "disallowed command: undefined" (issue #300).
 */
export const UPLINK_ERROR_MESSAGE: Record<UplinkErrorReason, string> = {
  unauthorized:
    'the control server rejected the uplink token (invalid or expired)',
  'already-connected':
    'another Streamwall instance is already connected to the control server',
}

export type UplinkWsMessageRoute =
  | { kind: 'yjs-update'; update: Uint8Array }
  | { kind: 'uplink-error'; reason: UplinkErrorReason; message: string }
  | { kind: 'command'; message: unknown }
  | { kind: 'parse-error'; error: unknown }

/**
 * Classifies an incoming control uplink WebSocket frame before the main process
 * applies Yjs updates or dispatches commands.
 */
export function routeUplinkWsMessage(
  data: ArrayBuffer | string,
): UplinkWsMessageRoute {
  if (data instanceof ArrayBuffer) {
    return { kind: 'yjs-update', update: new Uint8Array(data) }
  }

  let message: unknown
  try {
    message = JSON.parse(data)
  } catch (error) {
    return { kind: 'parse-error', error }
  }

  const uplinkError = parseUplinkError(message)
  if (uplinkError) {
    return {
      kind: 'uplink-error',
      reason: uplinkError,
      message: UPLINK_ERROR_MESSAGE[uplinkError],
    }
  }

  return { kind: 'command', message }
}
