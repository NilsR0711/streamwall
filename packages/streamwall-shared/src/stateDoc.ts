import * as Y from 'yjs'

/**
 * The shared Yjs "state doc" has a deliberately narrow shape: a single
 * top-level `views` map keyed by integer strings, each holding a nested map
 * whose only key is a `streamId` string (or `undefined` for an empty cell).
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
    if (!/^\d+$/.test(key)) {
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
