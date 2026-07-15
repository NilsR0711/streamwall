import { useCallback, useEffect, useState } from 'preact/hooks'
import * as Y from 'yjs'
import { type ZodType, prettifyError } from 'zod'
import { createSharedUndoManager } from './yUndo.ts'

export function useYDoc<T>(
  keys: string[],
  // Validates each doc snapshot before it replaces `docValue`. The doc is
  // shared/collaborative state - written to by every connected client and,
  // on the Electron side, synced from the main process - so a malformed
  // snapshot (a stale client on an old schema, a manual doc edit, a future
  // field rename) must be rejected rather than cast, or it would corrupt the
  // UI silently and only surface later, far from the actual cause (issue
  // #322).
  schema: ZodType<T>,
  // Origin string used by this connection when applying remote updates to
  // `doc` (e.g. `'server'` for the websocket client, `'app'` for the
  // Electron IPC renderer). Passed through to the doc's `Y.UndoManager` so
  // that remotely-applied changes - notably a destructive grid-shrink remap,
  // which runs on the main process's doc and only reaches here as a
  // remote-origin update - are undoable too (issue #79).
  remoteOrigin?: string,
): {
  docValue: T | undefined
  doc: Y.Doc
  setDoc: (doc: Y.Doc) => void
  undoManager: Y.UndoManager | undefined
} {
  const [doc, setDocState] = useState(() => new Y.Doc())
  // Callers (e.g. re-establishing a connection) replace the doc wholesale.
  // Free the outgoing doc's listeners/structs rather than leaking it.
  const setDoc = useCallback((newDoc: Y.Doc) => {
    setDocState((oldDoc) => {
      if (oldDoc !== newDoc) {
        oldDoc.destroy()
      }
      return newDoc
    })
  }, [])
  const [docValue, setDocValue] = useState<T>()
  useEffect(() => {
    function updateDocValue() {
      const valueCopy = Object.fromEntries(
        keys.map((k) => [k, doc.getMap(k).toJSON()]),
      )
      const result = schema.safeParse(valueCopy)
      if (result.success) {
        setDocValue(result.data)
      } else {
        console.warn(
          'useYDoc: doc snapshot failed validation, keeping the last known-good value',
          prettifyError(result.error),
        )
      }
    }
    updateDocValue()
    doc.on('update', updateDocValue)
    return () => {
      doc.off('update', updateDocValue)
    }
    // `keys` and `schema` are deliberately omitted: every caller passes a
    // literal array/module-level schema, so including them would
    // re-subscribe the listener on every render without any behavioral
    // benefit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc])

  const [undoManager, setUndoManager] = useState<Y.UndoManager>()
  useEffect(() => {
    const manager = createSharedUndoManager(doc, keys, remoteOrigin)
    setUndoManager(manager)
    return () => {
      manager.destroy()
    }
    // `keys` is deliberately omitted for the same reason as above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, remoteOrigin])

  return { docValue, doc, setDoc, undoManager }
}
