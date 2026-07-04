import { isValidStateDocShape } from 'streamwall-shared'
import * as Y from 'yjs'

export interface DocUpdateLimits {
  /** Maximum size, in bytes, of a single inbound Yjs update. */
  maxUpdateBytes: number
  /** Maximum number of bytes a single update may add to the encoded doc. */
  maxDocGrowthBytes: number
}

/**
 * Applies an untrusted binary Yjs update to `doc` only if it is well-formed,
 * within the configured limits, and leaves the doc matching the expected
 * state-doc shape.
 *
 * Rather than mutating the live doc and trying to unwind a bad update (which a
 * CRDT cannot cleanly do), the update is first replayed onto a throwaway probe
 * seeded with the current state. Only when the probe passes every check is the
 * update applied to the real doc — so its `update` event (and the broadcast it
 * drives) never fires for a rejected update. Returns whether it was applied.
 *
 * The size bound is on how much a single update *grows* the doc, not on the
 * doc's absolute size: the absolute size is set by the trusted uplink's
 * canonical snapshot, so an absolute cap would drop every later client edit
 * once the doc is large. The check runs synchronously (no `await` between
 * measuring and applying), so concurrent connection handlers cannot interleave
 * and collectively exceed the bound.
 */
export function applyValidatedDocUpdate(
  doc: Y.Doc,
  update: Uint8Array,
  limits: DocUpdateLimits,
  origin?: unknown,
): boolean {
  if (update.byteLength > limits.maxUpdateBytes) {
    return false
  }

  const liveBytes = Y.encodeStateAsUpdate(doc).byteLength

  const probe = new Y.Doc()
  try {
    Y.applyUpdate(probe, Y.encodeStateAsUpdate(doc))
    Y.applyUpdate(probe, update)
  } catch {
    // Malformed update bytes fail to decode.
    return false
  }

  const growthBytes = Y.encodeStateAsUpdate(probe).byteLength - liveBytes
  if (growthBytes > limits.maxDocGrowthBytes) {
    return false
  }

  if (!isValidStateDocShape(probe)) {
    return false
  }

  Y.applyUpdate(doc, update, origin)
  return true
}
