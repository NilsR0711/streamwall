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
 * Reads the disconnect reason out of a parsed control-server websocket
 * message. The server sends `{error: '...'}` immediately before closing the
 * socket when the session is invalid or the Streamwall app itself isn't
 * connected; every other message (state pushes, command responses, or an
 * unrelated error like "streamwall already connected") returns `null`.
 */
export function parseDisconnectReason(
  message: unknown,
): DisconnectReason | null {
  if (
    typeof message !== 'object' ||
    message === null ||
    !('error' in message)
  ) {
    return null
  }
  const { error } = message as { error: unknown }
  if (typeof error !== 'string') {
    return null
  }
  return REASON_BY_SERVER_ERROR[error] ?? null
}
