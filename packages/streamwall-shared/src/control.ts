// Credential format shared by the two ends of the Streamwall uplink protocol.
//
// The uplink authenticates with an `Authorization: Bearer <tokenId>:<secret>`
// header instead of a URL query string, so the secret never lands in access
// logs, browser history, or the Referer header.

export interface ControlCredential {
  tokenId: string
  secret: string
}

/** Serialize a credential into the `<tokenId>:<secret>` bearer value. */
export function formatBearerCredential({
  tokenId,
  secret,
}: ControlCredential): string {
  return `${tokenId}:${secret}`
}

/**
 * Parse an `Authorization: Bearer <tokenId>:<secret>` header value. Returns
 * null for anything malformed (missing scheme, missing separator, empty parts).
 * Token ids and secrets are base62 and never contain a colon, so the split is
 * unambiguous on the first `:`.
 */
export function parseBearerCredential(
  header: string | undefined | null,
): ControlCredential | null {
  if (!header) {
    return null
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (!match) {
    return null
  }
  const value = match[1]
  const sep = value.indexOf(':')
  if (sep <= 0 || sep >= value.length - 1) {
    return null
  }
  return { tokenId: value.slice(0, sep), secret: value.slice(sep + 1) }
}

export interface ResolvedControlConnection {
  /** WebSocket endpoint with no embedded credentials. */
  endpoint: string
  /** `<tokenId>:<secret>` value for the Authorization header. */
  credential: string
  /** True when derived from a deprecated token-in-URL endpoint. */
  legacy: boolean
}

/**
 * Normalize control-server connection config into a clean endpoint plus a
 * bearer credential. Accepts the modern form (separate endpoint + token) and
 * the deprecated form where the endpoint embeds `/streamwall/<id>/ws?token=`.
 * Returns null when no usable credential is available.
 */
export function resolveControlConnection({
  endpoint,
  token,
}: {
  endpoint?: string | null
  token?: string | null
}): ResolvedControlConnection | null {
  if (!endpoint) {
    return null
  }

  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    // Not a parseable URL: fall back to using it verbatim with an explicit token.
    return token ? { endpoint, credential: token, legacy: false } : null
  }

  const legacySecret = url.searchParams.get('token')
  if (legacySecret != null) {
    const segments = url.pathname.split('/').filter(Boolean)
    let tokenId: string | null = null
    if (
      segments.length >= 3 &&
      segments[0] === 'streamwall' &&
      segments[segments.length - 1] === 'ws'
    ) {
      tokenId = segments[segments.length - 2]
    }
    url.searchParams.delete('token')
    url.pathname = '/streamwall/ws'
    const credential = tokenId ? `${tokenId}:${legacySecret}` : legacySecret
    return { endpoint: url.toString(), credential, legacy: true }
  }

  if (!token) {
    return null
  }
  return { endpoint, credential: token, legacy: false }
}
