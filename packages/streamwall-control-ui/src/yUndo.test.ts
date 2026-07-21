import {
  asCellIdx,
  type CellIdx,
  remapGridAssignments,
} from 'streamwall-shared'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { createSharedUndoManager } from './yUndo.ts'

function seedViews(
  doc: Y.Doc,
  assignments: Map<CellIdx, string | undefined>,
): void {
  const views = doc.getMap<Y.Map<string | undefined>>('views')
  doc.transact(() => {
    for (const [idx, streamId] of assignments) {
      const cell = new Y.Map<string | undefined>()
      cell.set('streamId', streamId)
      views.set(String(idx), cell)
    }
  })
}

function readViews(doc: Y.Doc): Map<number, string | undefined> {
  const views = doc.getMap<Y.Map<string | undefined>>('views')
  const result = new Map<number, string | undefined>()
  for (const [key, cell] of views) {
    result.set(Number(key), cell.get('streamId'))
  }
  return result
}

describe('createSharedUndoManager', () => {
  it('undoes and redoes a local edit (e.g. a drag-move)', () => {
    const doc = new Y.Doc()
    seedViews(doc, new Map([[asCellIdx(0), undefined]]))
    const undoManager = createSharedUndoManager(doc, ['views'])

    doc
      .getMap<Y.Map<string | undefined>>('views')
      .get('0')
      ?.set('streamId', 'abc')
    expect(readViews(doc).get(0)).toBe('abc')

    undoManager.undo()
    expect(readViews(doc).get(0)).toBeUndefined()

    undoManager.redo()
    expect(readViews(doc).get(0)).toBe('abc')
  })

  it('does not track transactions whose origin is not local or the configured remote origin', () => {
    const doc = new Y.Doc()
    seedViews(doc, new Map([[asCellIdx(0), undefined]]))
    const undoManager = createSharedUndoManager(doc, ['views'], 'server')

    doc.transact(() => {
      doc
        .getMap<Y.Map<string | undefined>>('views')
        .get('0')
        ?.set('streamId', 'from-other-origin')
    }, 'some-other-origin')
    expect(readViews(doc).get(0)).toBe('from-other-origin')

    undoManager.undo()
    // Nothing was captured for this origin, so undo is a no-op.
    expect(readViews(doc).get(0)).toBe('from-other-origin')
  })

  it('restores assignments dropped by a destructive grid-shrink relayed from the server (issue #79)', () => {
    // Mirrors the real dataflow: an authoritative doc (main process) applies
    // `remapGridAssignments` and ships the resulting update to a client doc,
    // which applies it with a remote origin (`applyUpdate(clientDoc, update,
    // 'server')`, see streamwall-control-client's `receiveUpdate`).
    const oldCols = 2
    const oldAssignments = new Map<CellIdx, string | undefined>([
      [asCellIdx(0), 'keep-me'],
      [asCellIdx(1), 'drop-me'], // (x=1, y=0) falls outside a 1x1 grid.
    ])

    // The authoritative doc lives in the main process; the client doc mirrors
    // it via an initial full sync and then incremental updates - exactly like
    // `useYDoc`'s `doc.on('update', ...)` / `Y.applyUpdate(..., 'server')`
    // wiring in the real connections. Seeding both docs independently (rather
    // than syncing) would give their items unrelated identities and the
    // "delete" below wouldn't resolve against the client's copy.
    const serverDoc = new Y.Doc()
    seedViews(serverDoc, oldAssignments)

    const clientDoc = new Y.Doc()
    Y.applyUpdate(clientDoc, Y.encodeStateAsUpdate(serverDoc), 'server')
    const undoManager = createSharedUndoManager(clientDoc, ['views'], 'server')

    // Simulate the authoritative remap on the server doc, then relay the
    // resulting update onto the client doc under the 'server' origin.
    const newAssignments = remapGridAssignments(oldCols, 1, 1, oldAssignments)
    const stateBefore = Y.encodeStateVector(serverDoc)
    const serverViews = serverDoc.getMap<Y.Map<string | undefined>>('views')
    serverDoc.transact(() => {
      for (const key of [...serverViews.keys()]) {
        serverViews.delete(key)
      }
      for (const [idx, streamId] of newAssignments) {
        const cell = new Y.Map<string | undefined>()
        cell.set('streamId', streamId)
        serverViews.set(String(idx), cell)
      }
    })
    const update = Y.encodeStateAsUpdate(serverDoc, stateBefore)
    Y.applyUpdate(clientDoc, update, 'server')

    // The shrink dropped the out-of-grid assignment.
    expect(readViews(clientDoc).get(1)).toBeUndefined()
    expect([...readViews(clientDoc).keys()]).toEqual([0])

    undoManager.undo()

    const restored = readViews(clientDoc)
    expect(restored.get(0)).toBe('keep-me')
    expect(restored.get(1)).toBe('drop-me')
  })
})
