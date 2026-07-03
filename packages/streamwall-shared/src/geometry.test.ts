import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  boxesFromViewContentMap,
  idxInBox,
  idxToCoords,
  type ViewContent,
  type ViewContentMap,
} from './geometry.ts'

const video = (url: string): ViewContent => ({ url, kind: 'video' })

function contentMap(entries: Record<number, ViewContent>): ViewContentMap {
  return new Map(Object.entries(entries).map(([idx, c]) => [idx, c]))
}

function assertBox(
  box: { x: number; y: number; w: number; h: number },
  expected: { x: number; y: number; w: number; h: number },
) {
  assert.equal(box.x, expected.x)
  assert.equal(box.y, expected.y)
  assert.equal(box.w, expected.w)
  assert.equal(box.h, expected.h)
}

describe('idxToCoords', () => {
  test('maps indices to coordinates in a 4-wide grid', () => {
    assert.deepEqual(idxToCoords(4, 0), { x: 0, y: 0 })
    assert.deepEqual(idxToCoords(4, 3), { x: 3, y: 0 })
    assert.deepEqual(idxToCoords(4, 6), { x: 2, y: 1 })
    assert.deepEqual(idxToCoords(4, 15), { x: 3, y: 3 })
  })

  test('maps indices to coordinates in an 8-wide grid', () => {
    assert.deepEqual(idxToCoords(8, 15), { x: 7, y: 1 })
    assert.deepEqual(idxToCoords(8, 63), { x: 7, y: 7 })
  })
})

describe('idxInBox', () => {
  test('detects membership in a rectangular selection of a 4-wide grid', () => {
    // Selection from idx 0 (0,0) to idx 5 (1,1): the top-left 2x2 block.
    assert.equal(idxInBox(4, 0, 5, 0), true)
    assert.equal(idxInBox(4, 0, 5, 1), true)
    assert.equal(idxInBox(4, 0, 5, 4), true)
    assert.equal(idxInBox(4, 0, 5, 5), true)
    // Outside the block:
    assert.equal(idxInBox(4, 0, 5, 2), false)
    assert.equal(idxInBox(4, 0, 5, 6), false)
    assert.equal(idxInBox(4, 0, 5, 8), false)
  })

  test('is order-independent for start and end', () => {
    assert.equal(idxInBox(4, 5, 0, 1), true)
    assert.equal(idxInBox(4, 5, 0, 2), false)
  })
})

describe('boxesFromViewContentMap', () => {
  test('returns no boxes for an empty grid', () => {
    assert.deepEqual(boxesFromViewContentMap(4, 4, new Map()), [])
  })

  test('returns a single 1x1 box for one filled cell in a 4x4 grid', () => {
    const boxes = boxesFromViewContentMap(4, 4, contentMap({ 5: video('a') }))
    assert.equal(boxes.length, 1)
    assertBox(boxes[0], { x: 1, y: 1, w: 1, h: 1 })
    assert.deepEqual(boxes[0].spaces, [5])
  })

  test('merges adjacent equal content into one 2x2 box in a 4x4 grid', () => {
    const a = video('a')
    const boxes = boxesFromViewContentMap(
      4,
      4,
      contentMap({ 0: a, 1: a, 4: a, 5: a }),
    )
    assert.equal(boxes.length, 1)
    assertBox(boxes[0], { x: 0, y: 0, w: 2, h: 2 })
    assert.deepEqual(boxes[0].spaces, [0, 1, 4, 5])
  })

  test('keeps distinct content in separate boxes', () => {
    const boxes = boxesFromViewContentMap(
      4,
      4,
      contentMap({ 0: video('a'), 1: video('b') }),
    )
    assert.equal(boxes.length, 2)
    const urls = boxes.map((b) => b.content?.url).sort()
    assert.deepEqual(urls, ['a', 'b'])
  })

  test('merges a fully filled 8x8 grid into a single box', () => {
    const a = video('a')
    const full: Record<number, ViewContent> = {}
    for (let i = 0; i < 64; i++) {
      full[i] = a
    }
    const boxes = boxesFromViewContentMap(8, 8, contentMap(full))
    assert.equal(boxes.length, 1)
    assertBox(boxes[0], { x: 0, y: 0, w: 8, h: 8 })
    assert.equal(boxes[0].spaces.length, 64)
  })

  test('does not merge across rows when a column differs (non-square 4x2)', () => {
    const a = video('a')
    // Fill the entire top row (cols 0..3) of a 4x2 grid.
    const boxes = boxesFromViewContentMap(
      4,
      2,
      contentMap({ 0: a, 1: a, 2: a, 3: a }),
    )
    assert.equal(boxes.length, 1)
    assertBox(boxes[0], { x: 0, y: 0, w: 4, h: 1 })
    assert.deepEqual(boxes[0].spaces, [0, 1, 2, 3])
  })
})
