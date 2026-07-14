/** Standard `readyState` value for an open, ready-to-send WebSocket connection. */
export const SOCKET_OPEN = 1

/** The minimal shape both the native `WebSocket` and `ReconnectingWebSocket` satisfy. */
export interface ReadyStateSocket {
  readonly readyState: number
}

/**
 * Returns whether a WebSocket (or ReconnectingWebSocket) is currently OPEN.
 *
 * ReconnectingWebSocket defaults to an unbounded send queue: any `send()`
 * call made while CONNECTING/CLOSED is buffered forever and replayed once
 * the connection reopens. For traffic that already gets a full resync on
 * reconnect (a full state broadcast, a full Yjs doc sync), that buffering is
 * pure downside — unbounded memory growth while offline, then a burst of
 * stale frames on reconnect. Callers sending that kind of traffic should
 * guard with this check and skip the send entirely while closed, relying on
 * the resync-on-open path instead.
 */
export function isSocketOpen(ws: ReadyStateSocket): boolean {
  return ws.readyState === SOCKET_OPEN
}
