/**
 * Derives the control WebSocket endpoint from the Vite `BASE_URL` and the
 * page location.
 *
 * The published Docker image always builds the client with `BASE_URL = '/'`,
 * so the scheme must come from the page: a client served over `https:` has to
 * open `wss://` — browsers block insecure WebSockets from secure contexts, so
 * a hardcoded `ws://` left TLS deployments permanently disconnected (issue
 * #617). An absolute `http(s)://` base (a `STREAMWALL_CONTROL_URL` build) is
 * mapped to `ws(s)://` the same way; `ws://`/`wss://` bases pass through.
 */
export function getWebsocketEndpoint(
  baseUrl: string,
  location: { protocol: string; host: string },
): string {
  const pageWsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  // Resolves relative bases ('/', '/some/path/') against the page host with
  // the page-derived scheme; absolute bases keep their own origin.
  const url = new URL(baseUrl, `${pageWsProtocol}//${location.host}`)
  if (url.protocol === 'http:') {
    url.protocol = 'ws:'
  } else if (url.protocol === 'https:') {
    url.protocol = 'wss:'
  }
  return `${url.origin}${url.pathname.replace(/\/$/, '')}/client/ws`
}
