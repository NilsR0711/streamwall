import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'

// Addresses an operator-supplied URL must never be allowed to reach. Covers
// loopback, private LAN, carrier-grade NAT, link-local (including the cloud
// metadata endpoint 169.254.169.254) and the unspecified address, for both
// IPv4 and IPv6. Using a BlockList lets Node match IPv4-mapped IPv6 addresses
// (e.g. ::ffff:127.0.0.1) against the IPv4 rules automatically; the NAT64 and
// 6to4 prefixes below cover the other IPv4-embedding IPv6 transition forms,
// which BlockList does not unwrap on its own.
const blockedAddresses = new BlockList()
blockedAddresses.addSubnet('0.0.0.0', 8, 'ipv4') // "this" network / unspecified
blockedAddresses.addSubnet('10.0.0.0', 8, 'ipv4') // private
blockedAddresses.addSubnet('100.64.0.0', 10, 'ipv4') // carrier-grade NAT
blockedAddresses.addSubnet('127.0.0.0', 8, 'ipv4') // loopback
blockedAddresses.addSubnet('169.254.0.0', 16, 'ipv4') // link-local
blockedAddresses.addSubnet('172.16.0.0', 12, 'ipv4') // private
blockedAddresses.addSubnet('192.168.0.0', 16, 'ipv4') // private
blockedAddresses.addAddress('::', 'ipv6') // unspecified
blockedAddresses.addAddress('::1', 'ipv6') // loopback
blockedAddresses.addSubnet('fc00::', 7, 'ipv6') // unique local
blockedAddresses.addSubnet('fe80::', 10, 'ipv6') // link-local
blockedAddresses.addSubnet('64:ff9b::', 96, 'ipv6') // NAT64 (embeds IPv4)
blockedAddresses.addSubnet('2002::', 16, 'ipv6') // 6to4 (embeds IPv4)

function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip)
  if (family === 0) {
    return false
  }
  return blockedAddresses.check(ip, family === 6 ? 'ipv6' : 'ipv4')
}

function isLoopbackHostname(hostname: string): boolean {
  // localhost and any subdomain of it are defined to resolve to loopback
  // (RFC 6761), so block them without consulting DNS.
  const host = hostname.toLowerCase()
  return host === 'localhost' || host.endsWith('.localhost')
}

export type HostAddressResolver = (hostname: string) => Promise<string[]>

const resolveHostAddresses: HostAddressResolver = async (hostname) => {
  const results = await lookup(hostname, { all: true })
  return results.map((result) => result.address)
}

// Structural view of the DNS-resolution surface Electron's `Session` exposes
// (see `session.resolveHost` in the Electron API), kept independent of the
// `electron` module so this file — and its tests — stay Electron-free.
interface HostResolvingSession {
  resolveHost(host: string): Promise<{ endpoints: { address: string }[] }>
}

/**
 * Builds a {@link HostAddressResolver} backed by a session's own DNS resolver
 * — the same resolver, and same cache, Chromium uses to actually connect —
 * instead of Node's independent `dns.lookup`. Callers that have a session
 * available (every real call site does) should pass this to
 * {@link ensureValidURL} / {@link findRequestBlockReason} so the validated
 * address is very likely the one still in the session's cache when the real
 * connection is made moments later, narrowing the DNS-rebinding
 * time-of-check/time-of-use gap described in #169.
 *
 * This narrows the gap; it does not close it. Chromium can still re-resolve
 * independently if the cache entry it just populated has already expired
 * (e.g. an attacker serving a TTL of 0), and Electron/Chromium currently
 * expose no API to pin a single request's connection to a specific,
 * pre-validated address. The network-layer guard
 * (`findRequestBlockReason`/`installRequestSSRFGuard`) therefore remains
 * necessary as defense in depth, not a complete fix on its own.
 */
export function createSessionHostResolver(
  session: HostResolvingSession,
): HostAddressResolver {
  return async (hostname) => {
    const { endpoints } = await session.resolveHost(hostname)
    return endpoints.map((endpoint) => endpoint.address)
  }
}

/**
 * Validate a URL before it is loaded into a WebContentsView. Rejects any URL
 * that is not http(s) or that points at a non-public host, guarding against
 * SSRF into the desktop host's own network (loopback, LAN, cloud metadata,
 * etc.). Hostnames are resolved and every resulting address is checked, so a
 * public domain that maps to a private address is rejected too.
 *
 * Note: DNS is re-resolved by the loader afterwards, so passing the default
 * resolver does not defend against active DNS-rebinding; it blocks
 * statically-malicious and literal-address targets, which is the reported
 * operator SSRF vector. Callers should pass a
 * {@link createSessionHostResolver} bound to the session that will actually
 * load the URL — this narrows (but, per that function's docs, does not
 * eliminate) the DNS-rebinding gap by sharing the loader's own resolver and
 * cache instead of an independent lookup.
 */
export async function ensureValidURL(
  urlStr: string,
  resolveAddresses: HostAddressResolver = resolveHostAddresses,
): Promise<void> {
  const url = new URL(urlStr)

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`rejecting attempt to load non-http URL '${urlStr}'`)
  }

  // IPv6 literals are bracketed in url.hostname (e.g. "[::1]"), and a fully
  // qualified name may carry a trailing dot (e.g. "localhost."); strip both so
  // the loopback fast-path cannot be skipped by a trailing dot.
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '')
  if (hostname === '') {
    throw new Error(`rejecting attempt to load URL with no host '${urlStr}'`)
  }

  if (isLoopbackHostname(hostname)) {
    throw new Error(`rejecting attempt to load loopback URL '${urlStr}'`)
  }

  if (isIP(hostname) !== 0) {
    if (isBlockedAddress(hostname)) {
      throw new Error(
        `rejecting attempt to load private-network URL '${urlStr}'`,
      )
    }
    return
  }

  let addresses: string[]
  try {
    addresses = await resolveAddresses(hostname)
  } catch (err) {
    throw new Error(
      `rejecting URL with unresolvable host '${urlStr}': ${String(err)}`,
      { cause: err },
    )
  }
  if (addresses.length === 0) {
    throw new Error(`rejecting URL with unresolvable host '${urlStr}'`)
  }
  for (const address of addresses) {
    if (isBlockedAddress(address)) {
      throw new Error(
        `rejecting attempt to load private-network URL '${urlStr}' (${hostname} resolves to ${address})`,
      )
    }
  }
}

/**
 * Network-layer counterpart of {@link ensureValidURL}, meant to run on every
 * request a view's session issues — including HTTP redirects and sub-resources
 * (e.g. HLS variant/segment fetches) that never pass through the initial
 * string check. Returns a short reason when the request must be cancelled, or
 * null when it is allowed.
 *
 * It reuses the same non-public-address classification but differs from
 * `ensureValidURL` in two deliberate ways that suit a per-request hook:
 *   - Only http(s)/ws(s) are governed. Other schemes (file:, data:, blob:,
 *     devtools:, …) are the app's own machinery and are always allowed; an
 *     unparseable URL is likewise left for the network stack to reject.
 *     ws:/wss: is included because a page loaded into a view can open a
 *     WebSocket to an internal host from script, the same class of SSRF as an
 *     http(s) sub-resource fetch.
 *   - It fails *open* on a resolution failure. Only a positive match — a
 *     loopback hostname or an address that classifies as non-public — blocks a
 *     request, so a transient DNS hiccup on a legitimate public host does not
 *     cancel its traffic.
 */
export async function findRequestBlockReason(
  urlStr: string,
  resolveAddresses: HostAddressResolver = resolveHostAddresses,
): Promise<string | null> {
  let url: URL
  try {
    url = new URL(urlStr)
  } catch {
    return null
  }

  if (
    url.protocol !== 'http:' &&
    url.protocol !== 'https:' &&
    url.protocol !== 'ws:' &&
    url.protocol !== 'wss:'
  ) {
    return null
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '')
  if (hostname === '') {
    return null
  }

  if (isLoopbackHostname(hostname)) {
    return `blocking request to loopback host '${urlStr}'`
  }

  if (isIP(hostname) !== 0) {
    return isBlockedAddress(hostname)
      ? `blocking request to private-network address '${urlStr}'`
      : null
  }

  let addresses: string[]
  try {
    addresses = await resolveAddresses(hostname)
  } catch {
    // Fail open: an unresolvable host cannot be positively classified as
    // private, and the network stack will fail the request on its own if the
    // name is genuinely dead.
    return null
  }
  for (const address of addresses) {
    if (isBlockedAddress(address)) {
      return `blocking request to private-network URL '${urlStr}' (${hostname} resolves to ${address})`
    }
  }
  return null
}
