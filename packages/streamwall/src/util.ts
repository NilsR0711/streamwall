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

type HostAddressResolver = (hostname: string) => Promise<string[]>

const resolveHostAddresses: HostAddressResolver = async (hostname) => {
  const results = await lookup(hostname, { all: true })
  return results.map((result) => result.address)
}

/**
 * Validate a URL before it is loaded into a WebContentsView. Rejects any URL
 * that is not http(s) or that points at a non-public host, guarding against
 * SSRF into the desktop host's own network (loopback, LAN, cloud metadata,
 * etc.). Hostnames are resolved and every resulting address is checked, so a
 * public domain that maps to a private address is rejected too.
 *
 * Note: DNS is re-resolved by the loader afterwards, so this does not defend
 * against active DNS-rebinding; it blocks statically-malicious and
 * literal-address targets, which is the reported operator SSRF vector.
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
