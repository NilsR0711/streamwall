/**
 * Hosts for which a plaintext `ws://` control connection is acceptable, because
 * loopback traffic never leaves the machine and cannot be intercepted by a
 * network man-in-the-middle.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

function normalizeHostname(hostname: string): string {
  // The WHATWG URL parser wraps IPv6 hosts in brackets, e.g. `[::1]`.
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1)
  }
  return hostname
}

/**
 * Returns whether a control-server endpoint is safe for the Streamwall desktop
 * to connect to.
 *
 * The desktop executes commands received over this connection, so the channel
 * must be authenticated and tamper-proof. We require `wss://` (TLS, which
 * authenticates the server and prevents man-in-the-middle injection), with a
 * narrow exception for plaintext `ws://` to loopback hosts (local development,
 * where there is no network path to intercept).
 */
export function isSecureControlEndpoint(endpoint: string): boolean {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return false
  }

  const hostname = normalizeHostname(url.hostname)
  if (hostname === '') {
    return false
  }

  if (url.protocol === 'wss:') {
    return true
  }

  if (url.protocol === 'ws:') {
    return LOOPBACK_HOSTS.has(hostname)
  }

  return false
}
