import { type StreamList } from 'streamwall-shared'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { deriveWallViews } from './wallViews'

/** Builds a viewsState Y.Map with the given cell -> streamId assignments. */
function viewsStateWith(
  assignments: Record<string, string | undefined>,
): Y.Map<Y.Map<string | undefined>> {
  const doc = new Y.Doc()
  const viewsState = doc.getMap<Y.Map<string | undefined>>('views')
  doc.transact(() => {
    for (const [key, streamId] of Object.entries(assignments)) {
      const cell = new Y.Map<string | undefined>()
      cell.set('streamId', streamId)
      viewsState.set(key, cell)
    }
  })
  return viewsState
}

function streams(
  entries: { _id: string; link: string; kind?: string }[],
): StreamList {
  return entries as unknown as StreamList
}

describe('deriveWallViews — normal grid', () => {
  it('maps each assigned cell to its stream content', () => {
    const result = deriveWallViews({
      fullscreenViewIdx: null,
      streams: streams([
        { _id: 'a', link: 'http://a', kind: 'web' },
        { _id: 'b', link: 'http://b', kind: 'video' },
      ]),
      viewsState: viewsStateWith({ '0': 'a', '1': 'b' }),
      cols: 2,
      rows: 1,
    })

    expect(result.mode).toBe('normal')
    expect(result.contentMap.get('0')).toEqual({ url: 'http://a', kind: 'web' })
    expect(result.contentMap.get('1')).toEqual({
      url: 'http://b',
      kind: 'video',
    })
    if (result.mode === 'normal') {
      expect(result.clearedFullscreen).toBe(false)
    }
  })

  it('defaults a missing kind to "video"', () => {
    const result = deriveWallViews({
      fullscreenViewIdx: null,
      streams: streams([{ _id: 'a', link: 'http://a' }]),
      viewsState: viewsStateWith({ '0': 'a' }),
      cols: 1,
      rows: 1,
    })

    expect(result.contentMap.get('0')).toEqual({
      url: 'http://a',
      kind: 'video',
    })
  })

  it('skips cells whose stream is not present', () => {
    const result = deriveWallViews({
      fullscreenViewIdx: null,
      streams: streams([{ _id: 'a', link: 'http://a', kind: 'video' }]),
      viewsState: viewsStateWith({ '0': 'a', '1': 'missing' }),
      cols: 2,
      rows: 1,
    })

    expect(result.contentMap.has('0')).toBe(true)
    expect(result.contentMap.has('1')).toBe(false)
  })

  it('resolves cells through a caller-attached byId index', () => {
    // Only the attached index carries the stream; the array is empty, proving
    // the lookup does not fall back to scanning the list.
    const list = streams([])
    list.byId = new Map([
      ['a', { _id: 'a', link: 'http://a', kind: 'web' }],
    ]) as unknown as NonNullable<StreamList['byId']>

    const result = deriveWallViews({
      fullscreenViewIdx: null,
      streams: list,
      viewsState: viewsStateWith({ '0': 'a' }),
      cols: 1,
      rows: 1,
    })

    expect(result.contentMap.get('0')).toEqual({ url: 'http://a', kind: 'web' })
  })

  it('keeps the first stream when two share an id', () => {
    const result = deriveWallViews({
      fullscreenViewIdx: null,
      streams: streams([
        { _id: 'dup', link: 'http://first', kind: 'video' },
        { _id: 'dup', link: 'http://second', kind: 'web' },
      ]),
      viewsState: viewsStateWith({ '0': 'dup' }),
      cols: 1,
      rows: 1,
    })

    expect(result.contentMap.get('0')).toEqual({
      url: 'http://first',
      kind: 'video',
    })
  })
})

describe('deriveWallViews — fullscreen', () => {
  it('fills every cell with the expanded stream', () => {
    const result = deriveWallViews({
      fullscreenViewIdx: 1,
      streams: streams([{ _id: 'b', link: 'http://b', kind: 'video' }]),
      viewsState: viewsStateWith({ '0': undefined, '1': 'b' }),
      cols: 2,
      rows: 2,
    })

    expect(result.mode).toBe('fullscreen')
    // 2x2 grid -> all four cells carry the expanded content.
    expect(result.contentMap.size).toBe(4)
    for (let idx = 0; idx < 4; idx++) {
      expect(result.contentMap.get(String(idx))).toEqual({
        url: 'http://b',
        kind: 'video',
      })
    }
  })

  it('falls back to the normal grid and flags a cleared override when the stream is gone', () => {
    const result = deriveWallViews({
      fullscreenViewIdx: 1,
      // The expanded cell references 'gone', which is not in the stream list.
      streams: streams([{ _id: 'a', link: 'http://a', kind: 'video' }]),
      viewsState: viewsStateWith({ '0': 'a', '1': 'gone' }),
      cols: 2,
      rows: 1,
    })

    expect(result.mode).toBe('normal')
    if (result.mode === 'normal') {
      expect(result.clearedFullscreen).toBe(true)
    }
    // The still-present stream is laid out normally.
    expect(result.contentMap.get('0')).toEqual({
      url: 'http://a',
      kind: 'video',
    })
    expect(result.contentMap.has('1')).toBe(false)
  })
})
