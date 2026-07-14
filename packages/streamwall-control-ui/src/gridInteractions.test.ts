import { describe, expect, it } from 'vitest'

import {
  computeKeyboardResizeHoverIdx,
  computeResizeAssignments,
  computeSwap,
  isIdxInResizeBox,
  resizeWouldOverwriteOtherStream,
  type SwapBox,
} from './gridInteractions'

describe('computeSwap', () => {
  it('swaps two equal-sized (single-space) boxes', () => {
    const boxes = new Map<number, SwapBox>([
      [0, { spaces: [0], streamId: 'stream-a' }],
      [1, { spaces: [1], streamId: 'stream-b' }],
    ])

    expect(computeSwap(boxes, 0, 1, 3, 3)).toEqual(
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

    expect(computeSwap(boxes, 0, 1, 3, 3)).toEqual(
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

    expect(computeSwap(boxes, 0, 0, 3, 3)).toEqual(new Map())
  })

  it('treats a box missing from the map as a single space at its own index', () => {
    const boxes = new Map<number, SwapBox>([
      [1, { spaces: [1], streamId: 'stream-b' }],
    ])

    expect(computeSwap(boxes, 0, 1, 3, 3)).toEqual(
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

    expect(computeSwap(boxes, 0, 1, 3, 3)).toEqual(
      new Map([
        [0, 'stream-b'],
        [1, undefined],
      ]),
    )
  })

  it('translates a merged box onto an empty target instead of collapsing it to one cell', () => {
    // 4-col grid; a 2x2 box anchored at idx 0 occupies { 0,1, 4,5 }. Dragging
    // it (from its anchor) onto empty idx 10 (x2,y2) must move the whole
    // footprint there — { 10,11, 14,15 } — not just fill idx 10 alone while
    // clearing the other three source cells for nothing.
    const boxes = new Map<number, SwapBox>([
      [0, { spaces: [0, 1, 4, 5], streamId: 'stream-a' }],
    ])

    expect(computeSwap(boxes, 0, 10, 4, 4)).toEqual(
      new Map([
        [0, undefined],
        [1, undefined],
        [4, undefined],
        [5, undefined],
        [10, 'stream-a'],
        [11, 'stream-a'],
        [14, 'stream-a'],
        [15, 'stream-a'],
      ]),
    )
  })

  it('clamps the translated footprint to the grid bounds instead of distorting its shape', () => {
    // Same 2x2 box, but the drag targets idx 15 (x3,y3) — translating the
    // anchor there by the raw (dx,dy) would push the box half off the
    // 4x4 grid. The whole box must shift together and clamp so it still
    // lands fully on-grid as an intact 2x2 shape.
    const boxes = new Map<number, SwapBox>([
      [0, { spaces: [0, 1, 4, 5], streamId: 'stream-a' }],
    ])

    expect(computeSwap(boxes, 0, 15, 4, 4)).toEqual(
      new Map([
        [0, undefined],
        [1, undefined],
        [4, undefined],
        [5, undefined],
        [10, 'stream-a'],
        [11, 'stream-a'],
        [14, 'stream-a'],
        [15, 'stream-a'],
      ]),
    )
  })

  it('translates the footprint using the dragged cell as the reference point, not always the anchor', () => {
    // The pointer can grab any cell of a merged box, not just its top-left
    // anchor. Dragging from idx 5 (the box's bottom-right cell, x1y1) onto
    // empty idx 9 (x1y2) must move the whole box down by one row — landing
    // at { 4,5, 8,9 } — keeping the dragged cell under the drop target.
    const boxes = new Map<number, SwapBox>([
      [5, { spaces: [0, 1, 4, 5], streamId: 'stream-a' }],
    ])

    expect(computeSwap(boxes, 5, 9, 4, 4)).toEqual(
      new Map([
        [0, undefined],
        [1, undefined],
        [4, 'stream-a'],
        [5, 'stream-a'],
        [8, 'stream-a'],
        [9, 'stream-a'],
      ]),
    )
  })
})

describe('computeResizeAssignments', () => {
  it('assigns a single cell when the anchor and hover are the same', () => {
    expect(computeResizeAssignments(3, 4, 4, 'stream-a', 'se', [4])).toEqual(
      new Map([[4, 'stream-a']]),
    )
  })

  it('assigns every cell in the box spanned by the anchor and hover, overwriting other streams', () => {
    // 3-col grid; anchor at idx 0 (x0,y0), hover at idx 4 (x1,y1) spans the
    // 2x2 box { 0, 1, 3, 4 }. Cells 1 and 3 belong to other, unrelated boxes
    // before the resize — they must be overwritten by the anchor's stream.
    expect(computeResizeAssignments(3, 0, 4, 'stream-a', 'se', [0])).toEqual(
      new Map([
        [0, 'stream-a'],
        [1, 'stream-a'],
        [3, 'stream-a'],
        [4, 'stream-a'],
      ]),
    )
  })

  it('does not include cells outside the spanned box', () => {
    const assignments = computeResizeAssignments(3, 0, 4, 'stream-a', 'se', [0])
    expect(assignments.has(2)).toBe(false)
    expect(assignments.has(5)).toBe(false)
  })

  it('clamps to the anchor when the hover is dragged past it, instead of spanning backward', () => {
    // The anchor (top-left corner of the box) never moves. Dragging the 'se'
    // handle up and to the left of the anchor must not grow the box in that
    // direction — it must clamp to the anchor cell itself.
    expect(computeResizeAssignments(3, 4, 0, 'stream-a', 'se', [4])).toEqual(
      new Map([[4, 'stream-a']]),
    )
  })

  it('clears vacated cells when shrinking a box', () => {
    // 4-col grid; a 3x3 box anchored at idx 0 occupies { 0,1,2, 4,5,6, 8,9,10 }.
    // Shrinking via the 'se' handle to hover at idx 5 (x1,y1) leaves a 2x2 box
    // { 0,1, 4,5 } — the other five original cells must be explicitly cleared,
    // not left with the stale streamId.
    const originalSpaces = [0, 1, 2, 4, 5, 6, 8, 9, 10]
    const assignments = computeResizeAssignments(
      4,
      0,
      5,
      'stream-a',
      'se',
      originalSpaces,
    )
    expect(assignments).toEqual(
      new Map([
        [0, 'stream-a'],
        [1, 'stream-a'],
        [4, 'stream-a'],
        [5, 'stream-a'],
        [2, undefined],
        [6, undefined],
        [8, undefined],
        [9, undefined],
        [10, undefined],
      ]),
    )
  })

  it("locks the y-axis to the original box height when dragging the 'e' (east) handle", () => {
    // 4-col grid; a 1x2 box anchored at idx 0 occupies { 0, 4 } (height 2).
    // Dragging the east handle to idx 6 (x2,y1) must only grow the width —
    // the height stays locked at the original 2 rows regardless of hover y.
    const originalSpaces = [0, 4]
    expect(
      computeResizeAssignments(4, 0, 6, 'stream-a', 'e', originalSpaces),
    ).toEqual(
      new Map([
        [0, 'stream-a'],
        [1, 'stream-a'],
        [2, 'stream-a'],
        [4, 'stream-a'],
        [5, 'stream-a'],
        [6, 'stream-a'],
      ]),
    )
  })

  it("locks the x-axis to the original box width when dragging the 's' (south) handle", () => {
    // 4-col grid; a 2x1 box anchored at idx 0 occupies { 0, 1 } (width 2).
    // Dragging the south handle to idx 9 (x1,y2) must only grow the height —
    // the width stays locked at the original 2 columns regardless of hover x.
    const originalSpaces = [0, 1]
    expect(
      computeResizeAssignments(4, 0, 9, 'stream-a', 's', originalSpaces),
    ).toEqual(
      new Map([
        [0, 'stream-a'],
        [1, 'stream-a'],
        [4, 'stream-a'],
        [5, 'stream-a'],
        [8, 'stream-a'],
        [9, 'stream-a'],
      ]),
    )
  })
})

describe('computeKeyboardResizeHoverIdx', () => {
  // 4-col, 4-row grid; a 1x1 box anchored (and living) at idx 0.
  const cols = 4
  const rows = 4

  it('grows the east handle one cell to the right on ArrowRight', () => {
    expect(
      computeKeyboardResizeHoverIdx(cols, rows, 0, 'e', [0], 'ArrowRight'),
    ).toBe(1)
  })

  it('grows the south handle one cell down on ArrowDown', () => {
    expect(
      computeKeyboardResizeHoverIdx(cols, rows, 0, 's', [0], 'ArrowDown'),
    ).toBe(4)
  })

  it('shrinks a wider east box by one column on ArrowLeft', () => {
    // Box anchored at idx 0 currently spans { 0, 1, 2 } (width 3).
    expect(
      computeKeyboardResizeHoverIdx(cols, rows, 0, 'e', [0, 1, 2], 'ArrowLeft'),
    ).toBe(1)
  })

  it('ignores the cross-axis key for an east handle', () => {
    expect(
      computeKeyboardResizeHoverIdx(cols, rows, 0, 'e', [0], 'ArrowDown'),
    ).toBeUndefined()
    expect(
      computeKeyboardResizeHoverIdx(cols, rows, 0, 'e', [0], 'ArrowUp'),
    ).toBeUndefined()
  })

  it('ignores the cross-axis key for a south handle', () => {
    expect(
      computeKeyboardResizeHoverIdx(cols, rows, 0, 's', [0], 'ArrowRight'),
    ).toBeUndefined()
    expect(
      computeKeyboardResizeHoverIdx(cols, rows, 0, 's', [0], 'ArrowLeft'),
    ).toBeUndefined()
  })

  it('moves either axis, one cell at a time, for a se (corner) handle', () => {
    expect(
      computeKeyboardResizeHoverIdx(cols, rows, 0, 'se', [0], 'ArrowRight'),
    ).toBe(1)
    expect(
      computeKeyboardResizeHoverIdx(cols, rows, 0, 'se', [0], 'ArrowDown'),
    ).toBe(4)
  })

  it('clamps to the anchor and refuses to shrink past a 1-cell box', () => {
    expect(
      computeKeyboardResizeHoverIdx(cols, rows, 0, 'e', [0], 'ArrowLeft'),
    ).toBeUndefined()
    expect(
      computeKeyboardResizeHoverIdx(cols, rows, 0, 's', [0], 'ArrowUp'),
    ).toBeUndefined()
  })

  it('clamps to the grid bounds and refuses to grow past the last column/row', () => {
    // Box already spans the full width (cols=4: x 0..3).
    expect(
      computeKeyboardResizeHoverIdx(
        cols,
        rows,
        0,
        'e',
        [0, 1, 2, 3],
        'ArrowRight',
      ),
    ).toBeUndefined()
    // Box already spans the full height (rows=4: y 0..3).
    expect(
      computeKeyboardResizeHoverIdx(
        cols,
        rows,
        0,
        's',
        [0, 4, 8, 12],
        'ArrowDown',
      ),
    ).toBeUndefined()
  })

  it('returns undefined for a non-arrow key', () => {
    expect(
      computeKeyboardResizeHoverIdx(cols, rows, 0, 'se', [0], 'Enter'),
    ).toBeUndefined()
  })
})

describe('resizeWouldOverwriteOtherStream', () => {
  it('reports true when the box spanned by the resize covers a cell held by a different stream', () => {
    // 3-col grid; anchor at idx 0 (x0,y0), hover at idx 4 (x1,y1) spans the
    // 2x2 box { 0, 1, 3, 4 }. Cell 4 already belongs to a different stream.
    const currentAssignments = new Map([
      [0, 'stream-a'],
      [1, undefined],
      [3, undefined],
      [4, 'stream-b'],
    ])
    expect(
      resizeWouldOverwriteOtherStream(
        3,
        0,
        4,
        'stream-a',
        'se',
        [0],
        currentAssignments,
      ),
    ).toBe(true)
  })

  it('reports false when every spanned cell is already empty or already this stream', () => {
    const currentAssignments = new Map([
      [0, 'stream-a'],
      [1, undefined],
      [3, undefined],
      [4, undefined],
    ])
    expect(
      resizeWouldOverwriteOtherStream(
        3,
        0,
        4,
        'stream-a',
        'se',
        [0],
        currentAssignments,
      ),
    ).toBe(false)
  })

  it('treats an empty-string streamId the same as undefined', () => {
    const currentAssignments = new Map([
      [0, 'stream-a'],
      [1, ''],
    ])
    expect(
      resizeWouldOverwriteOtherStream(
        3,
        0,
        1,
        'stream-a',
        'e',
        [0],
        currentAssignments,
      ),
    ).toBe(false)
  })

  it('ignores cells outside the spanned box even if they belong to another stream', () => {
    // Same grid as above but hover only reaches idx 1 (width 2, height 1) —
    // cell 4's occupant is irrelevant since it falls outside the box.
    const currentAssignments = new Map([
      [0, 'stream-a'],
      [1, undefined],
      [4, 'stream-b'],
    ])
    expect(
      resizeWouldOverwriteOtherStream(
        3,
        0,
        1,
        'stream-a',
        'e',
        [0],
        currentAssignments,
      ),
    ).toBe(false)
  })

  it('does not flag a cell that is not present in the current assignments map', () => {
    const currentAssignments = new Map<number, string | undefined>([
      [0, 'stream-a'],
    ])
    expect(
      resizeWouldOverwriteOtherStream(
        3,
        0,
        1,
        'stream-a',
        'e',
        [0],
        currentAssignments,
      ),
    ).toBe(false)
  })
})

describe('isIdxInResizeBox', () => {
  it('matches the box computeResizeAssignments would commit, including axis locking and clamping', () => {
    const originalSpaces = [0, 4]
    // Growing the 'e' handle to idx 6: width grows to x<=2, height stays
    // locked to the original y<=1 — idx 10 (x2,y2) falls outside the height
    // lock even though it shares the grown column.
    expect(isIdxInResizeBox(4, 0, 6, 'e', originalSpaces, 2)).toBe(true)
    expect(isIdxInResizeBox(4, 0, 6, 'e', originalSpaces, 10)).toBe(false)
  })

  it('reports only the anchor cell when the hover is dragged past the anchor', () => {
    expect(isIdxInResizeBox(3, 4, 0, 'se', [4], 4)).toBe(true)
    expect(isIdxInResizeBox(3, 4, 0, 'se', [4], 0)).toBe(false)
  })
})
