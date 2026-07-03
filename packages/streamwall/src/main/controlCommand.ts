import type { ControlCommand } from 'streamwall-shared'

/**
 * Structural guard for control messages arriving from the network-exposed
 * control server (and the control window IPC channel).
 *
 * A failed `JSON.parse` yields `undefined` and a literal `null` frame parses to
 * `null`; both previously reached the command dispatcher and threw on
 * `msg.type`. This asserts only the minimum the dispatcher relies on — an object
 * with a string `type`. Unknown type strings dispatch safely (they match no
 * branch and are ignored); full per-command validation is a separate concern.
 */
export function isControlCommand(msg: unknown): msg is ControlCommand {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    typeof (msg as { type?: unknown }).type === 'string'
  )
}
