import * as Y from 'yjs'
import { MAX_VIEW_IDX } from './schemas.ts'

/**
 * The shared Yjs "state doc" has a deliberately narrow shape: a single
 * top-level `views` map keyed by integer strings within the addressable grid
 * range, each holding a nested map whose only key is a `streamId` string (or
 * `undefined` for an empty cell).
 *
 * Clients push raw binary Yjs updates into this doc, so after applying an
 * untrusted update we verify it still matches that shape. Anything else — an
 * extra top-level container, a non-map cell, a stray key, a non-string
 * streamId — indicates a malformed or malicious update and is rejected.
 */
export function isValidStateDocShape(doc: Y.Doc): boolean {
  // `views` is the only permitted top-level container.
  for (const name of doc.share.keys()) {
    if (name !== 'views') {
      return false
    }
  }

  // A top-level type applied from a binary update arrives untyped and only
  // takes shape once requested through a typed accessor. Reading it as a map
  // throws if it was instead created as a different type (e.g. an array).
  let views: Y.Map<unknown>
  try {
    views = doc.getMap('views')
  } catch {
    return false
  }

  for (const [key, cell] of views) {
    // Keys are integer strings within the same range the control commands
    // target, so an operator cannot accumulate phantom cells beyond the grid.
    if (!/^\d+$/.test(key) || Number(key) > MAX_VIEW_IDX) {
      return false
    }
    if (!(cell instanceof Y.Map)) {
      return false
    }
    for (const [cellKey, cellValue] of cell as Y.Map<unknown>) {
      if (cellKey !== 'streamId') {
        return false
      }
      if (cellValue !== undefined && typeof cellValue !== 'string') {
        return false
      }
    }
  }

  return true
}
