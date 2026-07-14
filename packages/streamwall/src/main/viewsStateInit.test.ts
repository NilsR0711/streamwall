import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  initializeViewsState,
  type ViewsStateInitContext,
} from './viewsStateInit'

function setup() {
  const doc = new Y.Doc()
  const viewsState = doc.getMap<Y.Map<string | undefined>>('views')
  const ctx: ViewsStateInitContext = {
    viewsState,
    transact: (fn) => doc.transact(fn),
  }
  return { doc, viewsState, ctx }
}

describe('initializeViewsState', () => {
  it('fills every cell of the configured grid', () => {
    const { viewsState, ctx } = setup()

    initializeViewsState(ctx, 2, 2)

    expect([...viewsState.keys()].sort()).toEqual(['0', '1', '2', '3'])
  })

  it('leaves an existing in-range assignment untouched', () => {
    const { viewsState, ctx } = setup()
    viewsState.doc!.transact(() => {
      const data = new Y.Map<string | undefined>()
      data.set('streamId', 'stream-a')
      viewsState.set('1', data)
    })

    initializeViewsState(ctx, 2, 2)

    expect(viewsState.get('1')?.get('streamId')).toBe('stream-a')
  })

  it('prunes a stale key left over from a previously larger grid (issue #17)', () => {
    const { viewsState, ctx } = setup()
    viewsState.doc!.transact(() => {
      // Leftover from a previous 8x8 config; never cleaned up because the old
      // fill logic only ever added missing keys.
      const ghost = new Y.Map<string | undefined>()
      ghost.set('streamId', 'ghost')
      viewsState.set('60', ghost)
    })

    initializeViewsState(ctx, 3, 3)

    expect(viewsState.has('60')).toBe(false)
    expect(
      [...viewsState.keys()].sort((a, b) => Number(a) - Number(b)),
    ).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8'])
  })

  it('is a no-op when the grid is already exactly filled', () => {
    const { viewsState, ctx } = setup()
    initializeViewsState(ctx, 2, 2)
    const before = [...viewsState.keys()].sort()

    initializeViewsState(ctx, 2, 2)

    expect([...viewsState.keys()].sort()).toEqual(before)
  })
})
