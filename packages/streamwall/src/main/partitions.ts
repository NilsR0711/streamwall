/**
 * Session partition helpers for isolating web content.
 *
 * Streamwall loads arbitrary third-party sites as stream views and lets the
 * operator open a browse window. Electron sessions are keyed by their
 * `partition` string: contexts that share a partition also share cookies,
 * localStorage and cache. A partition name beginning with `persist:` is written
 * to disk and survives across app restarts; any other name lives only in memory
 * and is discarded when its last web context goes away.
 *
 * To prevent cross-site data bleed and persistent tracking, every stream view
 * gets its own unique, ephemeral partition and the browse window gets a separate
 * ephemeral partition of its own.
 *
 * @see https://www.electronjs.org/docs/latest/api/session
 */

import type { Session } from 'electron'
import { createSessionHostResolver, findRequestBlockReason } from '../util'

const VIEW_PARTITION_PREFIX = 'view-'

/**
 * Dedicated ephemeral partition for the operator's browse window. It is
 * isolated from every stream view (which use the `view-` namespace) and is not
 * persisted to disk.
 */
export const BROWSE_PARTITION = 'browse'

/**
 * Creates a partition-name allocator. Each call to the returned function yields
 * the next sequential, ephemeral partition name for the given prefix, e.g.
 * `view-0`, `view-1`, ... The prefix must not begin with `persist:` so the
 * resulting sessions stay in memory only.
 */
export function createPartitionAllocator(prefix: string): () => string {
  let next = 0
  return () => `${prefix}${next++}`
}

/**
 * App-wide allocator for stream-view partitions. A module-level singleton
 * guarantees every view created during the process lifetime receives a distinct,
 * never-reused partition, so no two views can ever share a session.
 */
export const allocateViewPartition = createPartitionAllocator(
  VIEW_PARTITION_PREFIX,
)

// Minimal structural view of the request-filtering surface a session exposes,
// so the guard can be exercised without a running Electron app.
type RequestListener = (
  details: { url: string },
  callback: (response: { cancel: boolean }) => void,
) => void

interface RequestFilteringSession {
  webRequest: {
    onBeforeRequest(listener: RequestListener): void
  }
  resolveHost(host: string): Promise<{ endpoints: { address: string }[] }>
}

export interface RequestGuardOptions {
  /**
   * Origins that bypass the address check entirely (e.g. the Vite dev server on
   * loopback, which serves the HLS renderer page). Matched by host (hostname
   * plus port), not full origin, so the dev server's ws: HMR socket is covered
   * by the same entry as its http: origin. Empty in a packaged build.
   */
  allowedOrigins?: readonly string[]
  /**
   * Overridable for tests; defaults to the real address classifier, resolving
   * hostnames through the guarded session's own DNS resolver (see
   * {@link createSessionHostResolver}) rather than an independent lookup.
   */
  findBlockReason?: (url: string) => Promise<string | null>
}

/** Extracts the `host` (hostname[:port]) from an origin string, or undefined if unparseable. */
function hostOf(origin: string): string | undefined {
  try {
    return new URL(origin).host
  } catch {
    return undefined
  }
}

/**
 * Enforces the non-public-address policy at the network layer of a session, so
 * that *every* request it issues is checked — not just the initial URL string.
 * This closes the SSRF vectors a single up-front check structurally cannot
 * cover: HTTP 3xx redirects (Chromium re-enters `onBeforeRequest` for each hop),
 * sub-resources named inside loaded content (e.g. HLS variant/segment URIs
 * fetched by hls.js), and WebSockets opened by script inside the loaded page —
 * all of which are issued *after* `ensureValidURL` has run.
 *
 * Blocked requests are cancelled; a cancelled main-frame navigation surfaces as
 * a view error on the wall via the existing `did-fail-load` handler.
 */
export function installRequestSSRFGuard(
  session: RequestFilteringSession,
  {
    allowedOrigins = [],
    findBlockReason = (url) =>
      findRequestBlockReason(url, createSessionHostResolver(session)),
  }: RequestGuardOptions = {},
): void {
  const allowedHosts = new Set(
    allowedOrigins
      .filter(Boolean)
      .map(hostOf)
      .filter((host): host is string => host !== undefined),
  )
  session.webRequest.onBeforeRequest((details, callback) => {
    void (async () => {
      try {
        let host: string | undefined
        try {
          host = new URL(details.url).host
        } catch {
          host = undefined
        }
        if (host !== undefined && allowedHosts.has(host)) {
          callback({ cancel: false })
          return
        }
        const reason = await findBlockReason(details.url)
        if (reason !== null) {
          console.warn(reason)
          callback({ cancel: true })
          return
        }
        callback({ cancel: false })
      } catch (err) {
        // Fail open on an internal guard error: the up-front ensureValidURL
        // already vetted the top-level URL, and cancelling here would break
        // legitimate traffic on an unexpected fault.
        console.warn('SSRF request guard error:', err)
        callback({ cancel: false })
      }
    })()
  })
}

/**
 * Applies baseline hardening to a session: denies every permission request
 * (camera, microphone, geolocation, notifications, etc.) from web content and
 * installs the network-layer SSRF guard so redirects and sub-resources are
 * revalidated against the same non-public-address policy.
 *
 * Both handlers are per-session in Electron, so this must be called for each
 * isolated partition rather than once for a shared one.
 */
export function hardenSession(
  session: Pick<Session, 'setPermissionRequestHandler'> &
    RequestFilteringSession,
  options: RequestGuardOptions = {},
): void {
  session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
  installRequestSSRFGuard(session, options)
}
