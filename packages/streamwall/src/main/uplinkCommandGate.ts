import { isCommandAllowedFromUplink } from 'streamwall-shared'
import type { CommandSource } from './commandDispatch'

export type UplinkCommandGateResult =
  { allowed: true } | { allowed: false; type: unknown }

/**
 * Re-validates a command received over the remote control uplink against the
 * uplink allowlist. Local control-window commands bypass this gate.
 */
export function checkUplinkCommandGate(
  msg: unknown,
  source: CommandSource,
): UplinkCommandGateResult {
  if (source !== 'uplink') {
    return { allowed: true }
  }

  const type = (msg as { type?: unknown } | null)?.type
  if (typeof type !== 'string' || !isCommandAllowedFromUplink(type)) {
    return { allowed: false, type }
  }

  return { allowed: true }
}
