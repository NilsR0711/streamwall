import { describe, expect, it } from 'vitest'
import {
  resolveAnchorIdx,
  resolveEagerWriteStreamId,
  resolveTargetViewIdx,
  resolveWriteStreamId,
} from './viewPlacement.ts'

describe('resolveAnchorIdx', () => {
  it('uses the top-left cell when nothing is expanded', () => {
    expect(resolveAnchorIdx([4, 5], null)).toBe(4)
  })

  it('resolves a box covering the expanded cell to that cell', () => {
    // The fullscreen box spans the whole wall; its stream is only recorded at
    // the expanded cell (5), not at spaces[0] (0).
    expect(resolveAnchorIdx([0, 1, 2, 3, 4, 5], 5)).toBe(5)
  })

  it('ignores a stale expanded index no box covers', () => {
    expect(resolveAnchorIdx([4, 5], 9)).toBe(4)
  })
})

describe('resolveTargetViewIdx', () => {
  it('targets the focused input cell regardless of occupancy', () => {
    expect(
      resolveTargetViewIdx({
        views: { '0': { streamId: 'a' }, '2': { streamId: 'b' } },
        cellCount: 4,
        focusedInputIdx: 2,
      }),
    ).toBe(2)
  })

  it('picks the first empty cell when no input is focused', () => {
    expect(
      resolveTargetViewIdx({
        views: { '0': { streamId: 'a' }, '1': { streamId: 'b' } },
        cellCount: 4,
        focusedInputIdx: undefined,
      }),
    ).toBe(2)
  })

  it('returns undefined when every cell is occupied', () => {
    expect(
      resolveTargetViewIdx({
        views: {
          '0': { streamId: 'a' },
          '1': { streamId: 'b' },
          '2': { streamId: 'c' },
          '3': { streamId: 'd' },
        },
        cellCount: 4,
        focusedInputIdx: undefined,
      }),
    ).toBeUndefined()
  })

  it('treats a missing view slot as empty without throwing', () => {
    // After a grid enlargement the Yjs views map can momentarily lack entries
    // for the new cells while the JSON config already reports the larger grid.
    expect(
      resolveTargetViewIdx({
        views: { '0': { streamId: 'a' } },
        cellCount: 4,
        focusedInputIdx: undefined,
      }),
    ).toBe(1)
  })

  it('treats an empty streamId as an available cell', () => {
    expect(
      resolveTargetViewIdx({
        views: { '0': { streamId: 'a' }, '1': { streamId: '' } },
        cellCount: 4,
        focusedInputIdx: undefined,
      }),
    ).toBe(1)
  })
})

describe('resolveWriteStreamId', () => {
  it('keeps the streamId when the stream is known', () => {
    // Regression: a freshly-appeared stream must be placed, not cleared.
    expect(resolveWriteStreamId([{ _id: 'old' }, { _id: 'new' }], 'new')).toBe(
      'new',
    )
  })

  it('clears the cell when the stream is unknown', () => {
    expect(resolveWriteStreamId([{ _id: 'old' }], 'missing')).toBe('')
  })

  it('clears the cell when there are no streams', () => {
    expect(resolveWriteStreamId([], 'new')).toBe('')
  })
})

describe('resolveEagerWriteStreamId', () => {
  it('commits the streamId once it matches a known stream', () => {
    expect(
      resolveEagerWriteStreamId([{ _id: 'old' }, { _id: 'wolf' }], 'wolf'),
    ).toBe('wolf')
  })

  it('clears the cell once the input is emptied', () => {
    expect(resolveEagerWriteStreamId([{ _id: 'wolf' }], '')).toBe('')
  })

  it('does not commit a partial, non-matching keystroke', () => {
    // Regression: typing "wolf" character-by-character used to clear the
    // cell on every non-matching partial ("w", "wo", "wol"), tearing down
    // the view until the final matching keystroke landed.
    expect(resolveEagerWriteStreamId([{ _id: 'wolf' }], 'wol')).toBeUndefined()
  })

  it('does not commit an unknown value that will never match', () => {
    expect(resolveEagerWriteStreamId([{ _id: 'old' }], 'typo')).toBeUndefined()
  })
})
