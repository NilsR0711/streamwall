import { type ControlCommand } from 'streamwall-shared'

/**
 * Type guard for a control-server command response carrying an `error`
 * (e.g. `{ error: 'unauthorized' }`), as opposed to a successful reply or a
 * fire-and-forget command with no meaningful response payload.
 */
export function isErrorResponse(
  response: unknown,
): response is { error: string } {
  return (
    typeof response === 'object' &&
    response !== null &&
    typeof (response as { error?: unknown }).error === 'string'
  )
}

type Send = (msg: ControlCommand, cb?: (msg: unknown) => void) => void

/**
 * Wraps a `StreamwallConnection['send']` so a command's `{ error }` response
 * always reaches `onError`, regardless of whether the caller passed its own
 * response callback. Without this, an unauthorized or rejected command sent
 * without a callback (the common case) fails on the server while the UI
 * shows nothing (issue #35). On success, the caller's callback still
 * receives the response as before.
 */
export function createErrorSurfacingSend(
  send: Send,
  onError: (error: string) => void,
): Send {
  return (msg, cb) => {
    send(msg, (response) => {
      if (isErrorResponse(response)) {
        onError(response.error)
        return
      }
      cb?.(response)
    })
  }
}
