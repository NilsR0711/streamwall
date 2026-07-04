import { describe, expect, test } from 'vitest'
import * as Y from 'yjs'
import { isValidStateDocShape } from './stateDoc.ts'

/** Builds a Yjs update from a fresh doc mutated by `mutate`. */
function makeDoc(mutate: (doc: Y.Doc) => void): Y.Doc {
  const doc = new Y.Doc()
  doc.transact(() => mutate(doc))
  return doc
}

describe('isValidStateDocShape', () => {
  test('accepts an empty document', () => {
    expect(isValidStateDocShape(new Y.Doc())).toBe(true)
  })

  test('accepts the canonical views structure', () => {
    const doc = makeDoc((d) => {
      const views = d.getMap('views')
      for (let i = 0; i < 4; i++) {
        const cell = new Y.Map<string | undefined>()
        cell.set('streamId', i === 0 ? 'abc' : undefined)
        views.set(String(i), cell)
      }
    })
    expect(isValidStateDocShape(doc)).toBe(true)
  })

  test('rejects an unexpected top-level container', () => {
    const doc = makeDoc((d) => {
      d.getMap('views')
      d.getMap('evil').set('x', 'y')
    })
    expect(isValidStateDocShape(doc)).toBe(false)
  })

  test('rejects a top-level views that is not a map', () => {
    const doc = makeDoc((d) => {
      d.getArray('views').push(['nope'])
    })
    expect(isValidStateDocShape(doc)).toBe(false)
  })

  test('rejects a non-integer view key', () => {
    const doc = makeDoc((d) => {
      const cell = new Y.Map<string | undefined>()
      cell.set('streamId', 'abc')
      d.getMap('views').set('__proto__', cell)
    })
    expect(isValidStateDocShape(doc)).toBe(false)
  })

  test('rejects a view cell that is not a map', () => {
    const doc = makeDoc((d) => {
      d.getMap('views').set('0', 'not-a-map' as unknown as Y.Map<string>)
    })
    expect(isValidStateDocShape(doc)).toBe(false)
  })

  test('rejects an unknown key inside a view cell', () => {
    const doc = makeDoc((d) => {
      const cell = new Y.Map<string | undefined>()
      cell.set('streamId', 'abc')
      cell.set('evil', 'payload')
      d.getMap('views').set('0', cell)
    })
    expect(isValidStateDocShape(doc)).toBe(false)
  })

  test('rejects a non-string streamId value', () => {
    const doc = makeDoc((d) => {
      const cell = new Y.Map<unknown>()
      cell.set('streamId', 42)
      d.getMap('views').set('0', cell as Y.Map<string | undefined>)
    })
    expect(isValidStateDocShape(doc)).toBe(false)
  })
})
