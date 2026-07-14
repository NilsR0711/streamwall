/**
 * Reason the control-client's websocket to the control server is currently
 * closed, when the server explained why before closing it (see `/client/ws`
 * in streamwall-control-server). Not exhaustive by design - callers should
 * treat "no reason" (a `null` return from `parseDisconnectReason`) as a
 * generic, still-retrying disconnect (most likely a transient network blip).
 */
export type DisconnectReason =
  'unauthorized' | 'streamwall-disconnected' | 'rate-limited'

const REASON_BY_SERVER_ERROR: Record<string, DisconnectReason> = {
  unauthorized: 'unauthorized',
  'streamwall disconnected': 'streamwall-disconnected',
  'rate limit exceeded': 'rate-limited',
}

/**
 * Reason the control server refused the Streamwall desktop app's own uplink
 * connection (`/streamwall/:id/ws` in streamwall-control-server). Like the
 * browser client, the server sends `{error: '...'}` immediately before closing
 * the socket - but the uplink only ever sees these two rejections, distinct
 * from the browser client's reason set above.
 */
export type UplinkErrorReason = 'unauthorized' | 'already-connected'

const UPLINK_REASON_BY_SERVER_ERROR: Record<string, UplinkErrorReason> = {
  unauthorized: 'unauthorized',
  'streamwall already connected': 'already-connected',
}

/**
 * Extracts a `{error: '<string>'}` payload from a parsed control-server
 * message, returning the raw error string or `null` if the message isn't a
 * server error at all (a state push, a command, or malformed input). Shared by
 * the reason parsers below so both apply the same untrusted-input guard.
 */
function readServerError(message: unknown): string | null {
  if (
    typeof message !== 'object' ||
    message === null ||
    !('error' in message)
  ) {
    return null
  }
  const { error } = message as { error: unknown }
  return typeof error === 'string' ? error : null
}

/**
 * Reads the disconnect reason out of a parsed control-server websocket
 * message. The server sends `{error: '...'}` immediately before closing the
 * socket when the session is invalid or the Streamwall app itself isn't
 * connected; every other message (state pushes, command responses, or an
 * unrelated error like "streamwall already connected") returns `null`.
 */
export function parseDisconnectReason(
  message: unknown,
): DisconnectReason | null {
  const error = readServerError(message)
  return error === null ? null : (REASON_BY_SERVER_ERROR[error] ?? null)
}

/**
 * Reads the connection-refused reason out of a parsed control-server uplink
 * message. Returns `null` for anything that isn't a recognized `{error: '...'}`
 * rejection (a real command or a state push), so the desktop can forward those
 * onward unchanged instead of mistaking them for disallowed commands.
 */
export function parseUplinkError(message: unknown): UplinkErrorReason | null {
  const error = readServerError(message)
  return error === null ? null : (UPLINK_REASON_BY_SERVER_ERROR[error] ?? null)
}
