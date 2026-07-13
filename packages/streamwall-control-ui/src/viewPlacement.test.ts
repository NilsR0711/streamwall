import { describe, expect, it } from 'vitest'
import { resolveTargetViewIdx, resolveWriteStreamId } from './viewPlacement.ts'

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
