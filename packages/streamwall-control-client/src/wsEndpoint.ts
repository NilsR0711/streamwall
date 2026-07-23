/**
 * Resolves the control WebSocket endpoint from the build-time base URL and the
 * page location.
 *
 * The scheme is derived from how the page itself was loaded: browsers block
 * ws:// connections from secure contexts, so a client served over TLS (e.g.
 * the published Docker image behind a TLS-terminating proxy) must connect via
 * wss:// (issue #617). An explicit http(s) base is mapped to its WebSocket
 * counterpart, and upgraded to wss:// whenever the page is https.
 */
export function controlWebSocketEndpoint(
  baseURL: string,
  location: { protocol: string; host: string },
): string {
  const pageIsSecure = location.protocol === 'https:'
  let base =
    baseURL === '/'
      ? `${pageIsSecure ? 'wss:' : 'ws:'}//${location.host}`
      : baseURL.replace(/^http/, 'ws').replace(/\/$/, '')
  if (pageIsSecure) {
    base = base.replace(/^ws:/, 'wss:')
  }
  return `${base}/client/ws`
}
