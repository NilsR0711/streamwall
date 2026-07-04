import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import * as Y from 'yjs'
import { applyValidatedDocUpdate } from './stateDocGuard.ts'

const LIMITS = { maxUpdateBytes: 64 * 1024, maxDocBytes: 1024 * 1024 }

/** Encodes a full-state update from a fresh doc mutated by `mutate`. */
function updateFrom(mutate: (doc: Y.Doc) => void): Uint8Array {
  const doc = new Y.Doc()
  doc.transact(() => mutate(doc))
  return Y.encodeStateAsUpdate(doc)
}

function setCell(doc: Y.Doc, idx: number, streamId: string | undefined) {
  const cell = new Y.Map<string | undefined>()
  cell.set('streamId', streamId)
  doc.getMap('views').set(String(idx), cell)
}

describe('applyValidatedDocUpdate', () => {
  test('applies a valid views update and mutates the target doc', () => {
    const target = new Y.Doc()
    const applied = applyValidatedDocUpdate(
      target,
      updateFrom((d) => setCell(d, 0, 'abc')),
      LIMITS,
    )
    assert.equal(applied, true)
    assert.equal(
      target
        .getMap<Y.Map<string | undefined>>('views')
        .get('0')
        ?.get('streamId'),
      'abc',
    )
  })

  test('rejects an update larger than the message cap without mutating', () => {
    const target = new Y.Doc()
    const applied = applyValidatedDocUpdate(
      target,
      updateFrom((d) => setCell(d, 0, 'abc')),
      { maxUpdateBytes: 1, maxDocBytes: 1024 * 1024 },
    )
    assert.equal(applied, false)
    assert.equal(target.getMap('views').size, 0)
  })

  test('rejects an update that adds an unexpected top-level container', () => {
    const target = new Y.Doc()
    const applied = applyValidatedDocUpdate(
      target,
      updateFrom((d) => {
        d.getMap('evil').set('x', 'y')
      }),
      LIMITS,
    )
    assert.equal(applied, false)
    assert.equal(target.share.has('evil'), false)
  })

  test('rejects an update that writes a non-string streamId', () => {
    const target = new Y.Doc()
    const applied = applyValidatedDocUpdate(
      target,
      updateFrom((d) => {
        const cell = new Y.Map<unknown>()
        cell.set('streamId', 42)
        d.getMap('views').set('0', cell as Y.Map<string | undefined>)
      }),
      LIMITS,
    )
    assert.equal(applied, false)
  })

  test('rejects an update that would grow the doc beyond the size cap', () => {
    const target = new Y.Doc()
    const applied = applyValidatedDocUpdate(
      target,
      updateFrom((d) => setCell(d, 0, 'x'.repeat(1000))),
      { maxUpdateBytes: 64 * 1024, maxDocBytes: 100 },
    )
    assert.equal(applied, false)
    assert.equal(target.getMap('views').size, 0)
  })

  test('rejects malformed update bytes', () => {
    const target = new Y.Doc()
    const applied = applyValidatedDocUpdate(
      target,
      new Uint8Array([1, 2, 3, 255, 254]),
      LIMITS,
    )
    assert.equal(applied, false)
  })

  test('leaves the target unchanged when a later update is invalid', () => {
    const target = new Y.Doc()
    applyValidatedDocUpdate(
      target,
      updateFrom((d) => setCell(d, 0, 'keep')),
      LIMITS,
    )
    applyValidatedDocUpdate(
      target,
      updateFrom((d) => {
        d.getMap('evil').set('x', 'y')
      }),
      LIMITS,
    )
    assert.equal(
      target
        .getMap<Y.Map<string | undefined>>('views')
        .get('0')
        ?.get('streamId'),
      'keep',
    )
    assert.equal(target.share.has('evil'), false)
  })

  test('forwards the origin to the target update event on success', () => {
    const target = new Y.Doc()
    const origins: unknown[] = []
    target.on('update', (_update: Uint8Array, origin: unknown) => {
      origins.push(origin)
    })
    applyValidatedDocUpdate(
      target,
      updateFrom((d) => setCell(d, 0, 'abc')),
      LIMITS,
      'client-42',
    )
    assert.deepEqual(origins, ['client-42'])
  })
})
