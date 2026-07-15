import log from './logger'

export type CommandSource = 'local' | 'uplink'

/** Mirrors the control-server `{ error }` response shape for local IPC (#388). */
export type ControlCommandResult = { error: string }

function commandErrorFromThrown(err: unknown): ControlCommandResult {
  const message = err instanceof Error ? err.message : String(err)
  return { error: message }
}

// onCommand is async and is invoked fire-and-forget from the uplink
// WebSocket's 'message' event. That call site does not await or catch it,
// so a rejecting downstream `await` inside onCommand would otherwise escape
// as an unhandled promise rejection for every dispatched command (issue #256).
// Routing the uplink call site through here logs the failure instead.
export function dispatchCommand<Msg>(
  onCommand: (
    msg: Msg,
    source: CommandSource,
  ) => Promise<void | ControlCommandResult>,
  msg: Msg,
  source: CommandSource,
): void {
  onCommand(msg, source).catch((err) => {
    log.error(`Unhandled error while processing a ${source} command:`, err)
  })
}

/**
 * Awaits a local control-window command and returns any `{ error }` result to
 * the renderer over IPC, matching the WebSocket command contract (issue #388).
 */
export async function dispatchLocalCommand<Msg>(
  onCommand: (
    msg: Msg,
    source: 'local',
  ) => Promise<void | ControlCommandResult>,
  msg: Msg,
): Promise<void | ControlCommandResult> {
  try {
    return await onCommand(msg, 'local')
  } catch (err) {
    log.error('Unhandled error while processing a local command:', err)
    return commandErrorFromThrown(err)
  }
}
