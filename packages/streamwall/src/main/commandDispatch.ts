import log from './logger'

export type CommandSource = 'local' | 'uplink'

// onCommand is async and is invoked fire-and-forget from two event handlers:
// the control window's 'command' event and the uplink WebSocket's 'message'
// event. Neither awaits or catches it, so a rejecting downstream `await`
// inside onCommand would otherwise escape as an unhandled promise rejection
// for every dispatched command (issue #256). Routing both call sites through
// here logs the failure instead.
export function dispatchCommand<Msg>(
  onCommand: (msg: Msg, source: CommandSource) => Promise<void>,
  msg: Msg,
  source: CommandSource,
): void {
  onCommand(msg, source).catch((err) => {
    log.error(`Unhandled error while processing a ${source} command:`, err)
  })
}
