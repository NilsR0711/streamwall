import * as Y from 'yjs'

/**
 * Creates a `Y.UndoManager` scoped to the given root map keys of `doc`.
 *
 * By default, `Y.UndoManager` only tracks locally-originated transactions
 * (`origin === null`). Streamwall's control connections apply remote changes
 * under a fixed origin string (e.g. `'server'` for the websocket client,
 * `'app'` for the Electron IPC renderer - see `receiveUpdate`/`handleUpdate`
 * in their respective `index.tsx`/`control.tsx`). Passing that same string as
 * `remoteOrigin` makes those remote transactions undoable too, which is what
 * lets Ctrl+Z recover from a destructive grid-shrink remap (issue #79): that
 * remap runs on the main process's doc and reaches the client purely as a
 * remote-origin update.
 */
export function createSharedUndoManager(
  doc: Y.Doc,
  keys: string[],
  remoteOrigin?: string,
): Y.UndoManager {
  const trackedOrigins = new Set<unknown>([null])
  if (remoteOrigin !== undefined) {
    trackedOrigins.add(remoteOrigin)
  }
  return new Y.UndoManager(
    keys.map((key) => doc.getMap(key)),
    { trackedOrigins },
  )
}
