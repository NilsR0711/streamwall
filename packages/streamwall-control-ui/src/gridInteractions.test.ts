import { describe, expect, it } from 'vitest'

import {
  computeResizeAssignments,
  computeSwap,
  type SwapBox,
} from './gridInteractions'

describe('computeSwap', () => {
  it('swaps two equal-sized (single-space) boxes', () => {
    const boxes = new Map<number, SwapBox>([
      [0, { spaces: [0], streamId: 'stream-a' }],
      [1, { spaces: [1], streamId: 'stream-b' }],
    ])

    expect(computeSwap(boxes, 0, 1)).toEqual(
      new Map([
        [0, 'stream-b'],
        [1, 'stream-a'],
      ]),
    )
  })

  it('swaps boxes of unequal size, reassigning every space of both boxes', () => {
    // A 1x1 box at idx 0 and a 2x1 box spanning idx 1 and idx 2 (e.g. after a resize).
    const boxes = new Map<number, SwapBox>([
      [0, { spaces: [0], streamId: 'stream-a' }],
      [1, { spaces: [1, 2], streamId: 'stream-b' }],
    ])

    expect(computeSwap(boxes, 0, 1)).toEqual(
      new Map([
        [0, 'stream-b'],
        [1, 'stream-a'],
        [2, 'stream-a'],
      ]),
    )
  })

  it('is a no-op when dropped on its own box', () => {
    const boxes = new Map<number, SwapBox>([
      [0, { spaces: [0], streamId: 'stream-a' }],
    ])

    expect(computeSwap(boxes, 0, 0)).toEqual(new Map())
  })

  it('treats a box missing from the map as a single space at its own index', () => {
    const boxes = new Map<number, SwapBox>([
      [1, { spaces: [1], streamId: 'stream-b' }],
    ])

    expect(computeSwap(boxes, 0, 1)).toEqual(
      new Map([
        [0, 'stream-b'],
        [1, undefined],
      ]),
    )
  })

  it('swaps an empty box with an occupied one, clearing the target spaces', () => {
    const boxes = new Map<number, SwapBox>([
      [0, { spaces: [0], streamId: undefined }],
      [1, { spaces: [1], streamId: 'stream-b' }],
    ])

    expect(computeSwap(boxes, 0, 1)).toEqual(
      new Map([
        [0, 'stream-b'],
        [1, undefined],
      ]),
    )
  })
})

describe('computeResizeAssignments', () => {
  it('assigns a single cell when the anchor and hover are the same', () => {
    expect(computeResizeAssignments(3, 4, 4, 'stream-a')).toEqual(
      new Map([[4, 'stream-a']]),
    )
  })

  it('assigns every cell in the box spanned by the anchor and hover, overwriting other streams', () => {
    // 3-col grid; anchor at idx 0 (x0,y0), hover at idx 4 (x1,y1) spans the
    // 2x2 box { 0, 1, 3, 4 }. Cells 1 and 3 belong to other, unrelated boxes
    // before the resize — they must be overwritten by the anchor's stream.
    expect(computeResizeAssignments(3, 0, 4, 'stream-a')).toEqual(
      new Map([
        [0, 'stream-a'],
        [1, 'stream-a'],
        [3, 'stream-a'],
        [4, 'stream-a'],
      ]),
    )
  })

  it('spans the box the same way regardless of drag direction', () => {
    // Same 2x2 box as above, but dragged from the bottom-right corner back
    // up to the top-left anchor.
    expect(computeResizeAssignments(3, 4, 0, 'stream-a')).toEqual(
      new Map([
        [0, 'stream-a'],
        [1, 'stream-a'],
        [3, 'stream-a'],
        [4, 'stream-a'],
      ]),
    )
  })

  it('does not include cells outside the spanned box', () => {
    const assignments = computeResizeAssignments(3, 0, 4, 'stream-a')
    expect(assignments.has(2)).toBe(false)
    expect(assignments.has(5)).toBe(false)
  })
})
