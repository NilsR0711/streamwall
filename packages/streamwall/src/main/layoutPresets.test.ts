import type { LayoutPreset } from 'streamwall-shared'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  addLayoutPreset,
  applyLayoutPreset,
  buildLayoutPreset,
  MAX_LAYOUT_PRESETS,
} from './layoutPresets'

function makeViewsState(assignments: Record<number, string | undefined>) {
  const doc = new Y.Doc()
  const viewsState = doc.getMap<Y.Map<string | undefined>>('views')
  doc.transact(() => {
    for (const [key, streamId] of Object.entries(assignments)) {
      const data = new Y.Map<string | undefined>()
      data.set('streamId', streamId)
      viewsState.set(key, data)
    }
  })
  return { doc, viewsState }
}

describe('buildLayoutPreset', () => {
  it('captures the current grid dimensions and non-empty cell assignments', () => {
    const { viewsState } = makeViewsState({
      0: 'stream-a',
      1: undefined,
      2: 'stream-b',
    })

    const preset = buildLayoutPreset(
      { viewsState, cols: 2, rows: 2 },
      'preset-1',
      'My Layout',
    )

    expect(preset).toEqual<LayoutPreset>({
      id: 'preset-1',
      name: 'My Layout',
      cols: 2,
      rows: 2,
      views: {
        '0': { streamId: 'stream-a' },
        '2': { streamId: 'stream-b' },
      },
    })
  })

  it('produces an empty views object for an entirely empty grid', () => {
    const { viewsState } = makeViewsState({ 0: undefined, 1: undefined })

    const preset = buildLayoutPreset(
      { viewsState, cols: 2, rows: 1 },
      'preset-2',
      'Empty',
    )

    expect(preset.views).toEqual({})
  })
})

describe('addLayoutPreset', () => {
  const preset = (id: string): LayoutPreset => ({
    id,
    name: id,
    cols: 2,
    rows: 2,
    views: {},
  })

  it('appends a preset to the list', () => {
    const result = addLayoutPreset([preset('a')], preset('b'))
    expect(result.map((p) => p.id)).toEqual(['a', 'b'])
  })

  it('bounds the list to MAX_LAYOUT_PRESETS by dropping the oldest entries', () => {
    const full = Array.from({ length: MAX_LAYOUT_PRESETS }, (_, i) =>
      preset(`p${i}`),
    )

    const result = addLayoutPreset(full, preset('newest'))

    expect(result).toHaveLength(MAX_LAYOUT_PRESETS)
    expect(result[result.length - 1].id).toBe('newest')
    expect(result[0].id).toBe('p1')
    expect(result.some((p) => p.id === 'p0')).toBe(false)
  })
})

describe('applyLayoutPreset', () => {
  it('resizes the grid and rewrites viewsState to match the preset', () => {
    const { doc, viewsState } = makeViewsState({
      0: 'old-a',
      1: 'old-b',
      2: undefined,
      3: undefined,
    })

    let cols = 2
    let rows = 2
    const ctx = {
      viewsState,
      transact: (fn: () => void) => doc.transact(fn),
      setGridSize: (c: number, r: number) => {
        cols = c
        rows = r
      },
    }

    const preset: LayoutPreset = {
      id: 'preset-1',
      name: 'Saved',
      cols: 3,
      rows: 2,
      views: {
        '0': { streamId: 'new-a' },
        '4': { streamId: 'new-b' },
      },
    }

    applyLayoutPreset(ctx, preset)

    expect(cols).toBe(3)
    expect(rows).toBe(2)
    expect(
      [...viewsState.keys()].sort((a, b) => Number(a) - Number(b)),
    ).toEqual(['0', '1', '2', '3', '4', '5'])
    expect(viewsState.get('0')?.get('streamId')).toBe('new-a')
    expect(viewsState.get('4')?.get('streamId')).toBe('new-b')
    expect(viewsState.get('1')?.get('streamId')).toBeUndefined()
  })

  it('applies the new grid size before the transact observer runs', () => {
    const { doc, viewsState } = makeViewsState({ 0: 'a' })
    let cols = 1
    let rows = 1
    const observedDims: Array<[number, number]> = []
    viewsState.observeDeep(() => observedDims.push([cols, rows]))

    const ctx = {
      viewsState,
      transact: (fn: () => void) => doc.transact(fn),
      setGridSize: (c: number, r: number) => {
        cols = c
        rows = r
      },
    }

    applyLayoutPreset(ctx, {
      id: 'preset-1',
      name: 'Saved',
      cols: 2,
      rows: 2,
      views: {},
    })

    expect(observedDims.length).toBeGreaterThan(0)
    for (const dims of observedDims) {
      expect(dims).toEqual([2, 2])
    }
  })
})
