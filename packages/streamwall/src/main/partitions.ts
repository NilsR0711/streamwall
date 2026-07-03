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

/**
 * Applies baseline hardening to a session by denying every permission request
 * (camera, microphone, geolocation, notifications, etc.) from web content.
 *
 * Permission handlers are per-session in Electron, so this must be called for
 * each isolated partition rather than once for a shared one.
 */
export function hardenSession(
  session: Pick<Session, 'setPermissionRequestHandler'>,
): void {
  session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
}
