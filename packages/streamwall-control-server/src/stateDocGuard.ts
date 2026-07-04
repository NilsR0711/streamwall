import { isValidStateDocShape } from 'streamwall-shared'
import * as Y from 'yjs'

export interface DocUpdateLimits {
  /** Maximum size, in bytes, of a single inbound Yjs update. */
  maxUpdateBytes: number
  /** Maximum encoded size, in bytes, of the doc after applying an update. */
  maxDocBytes: number
}

/**
 * Applies an untrusted binary Yjs update to `doc` only if it is well-formed,
 * within the configured size limits, and leaves the doc matching the expected
 * state-doc shape.
 *
 * Rather than mutating the live doc and trying to unwind a bad update (which a
 * CRDT cannot cleanly do), the update is first replayed onto a throwaway probe
 * seeded with the current state. Only when the probe passes every check is the
 * update applied to the real doc — so its `update` event (and the broadcast it
 * drives) never fires for a rejected update. Returns whether it was applied.
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

  const probe = new Y.Doc()
  try {
    Y.applyUpdate(probe, Y.encodeStateAsUpdate(doc))
    Y.applyUpdate(probe, update)
  } catch {
    // Malformed update bytes fail to decode.
    return false
  }

  if (Y.encodeStateAsUpdate(probe).byteLength > limits.maxDocBytes) {
    return false
  }

  if (!isValidStateDocShape(probe)) {
    return false
  }

  Y.applyUpdate(doc, update, origin)
  return true
}
