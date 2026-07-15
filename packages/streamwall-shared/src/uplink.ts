import type { ControlCommand } from './schemas.ts'

/**
 * Commands the Streamwall desktop accepts from its remote control-server
 * uplink.
 *
 * The uplink is treated as untrusted: even a compromised or man-in-the-middled
 * control server must not be able to drive actions that lead to code execution
 * on the desktop (`browse`, `dev-tools`) or manipulate auth tokens
 * (`create-invite`, `delete-token`). Those remain available only from the
 * desktop's own local control window.
 *
 * This list is an explicit allowlist and is deliberately secure-by-default: any
 * command type not enumerated here — including new command types added later —
 * is rejected until it is knowingly added.
 */
const UPLINK_ALLOWED_COMMANDS: ReadonlySet<ControlCommand['type']> = new Set<
  ControlCommand['type']
>([
  'set-listening-view',
  'set-view-background-listening',
  'set-view-blurred',
  'set-view-volume',
  'rotate-stream',
  'update-custom-stream',
  'delete-custom-stream',
  'reload-view',
  'set-view-fullscreen',
  'set-stream-censored',
  'set-stream-running',
  'set-grid-size',
  'save-layout-preset',
  'load-layout-preset',
  'delete-layout-preset',
])

/**
 * Returns whether a command of the given type may be executed when it arrives
 * from the remote control-server uplink. Accepts arbitrary input so untrusted
 * messages can be validated safely; anything unrecognized is rejected.
 */
export function isCommandAllowedFromUplink(type: string): boolean {
  return (UPLINK_ALLOWED_COMMANDS as ReadonlySet<string>).has(type)
}
