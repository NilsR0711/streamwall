import {
  boxesFromViewContentMap,
  GRID_MAX,
  type ViewContentMap,
} from 'streamwall-shared'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { applyGridResize, type GridResizeContext } from './gridResize'

/**
 * Minimal-but-faithful stand-in for `StreamWindow`. It reproduces the one
 * behaviour that matters for issue #15: a running view survives a re-layout iff
 * its content still occupies a box in the *current* grid. The destroy/reuse
 * decision is delegated to the real shared geometry (`boxesFromViewContentMap`),
 * so it matches production without pulling in the Electron runtime.
 */
class FakeWall {
  cols: number
  rows: number
  /** content url -> stable view id (kept across setViews while still boxed). */
  live = new Map<string, number>()
  destroyed: number[] = []
  created: number[] = []
  private nextId = 1

  constructor(cols: number, rows: number) {
    this.cols = cols
    this.rows = rows
  }

  setGridSize(cols: number, rows: number) {
    this.cols = cols
    this.rows = rows
  }

  setViews(viewContentMap: ViewContentMap) {
    const boxes = boxesFromViewContentMap(this.cols, this.rows, viewContentMap)
    const wanted = new Set<string>()
    for (const box of boxes) {
      if (box.content) {
        wanted.add(box.content.url)
      }
    }
    // Destroy views whose content no longer has a box in the current grid.
    for (const [url, id] of [...this.live]) {
      if (!wanted.has(url)) {
        this.destroyed.push(id)
        this.live.delete(url)
      }
    }
    // Create views for newly boxed content.
    for (const url of wanted) {
      if (!this.live.has(url)) {
        const id = this.nextId++
        this.live.set(url, id)
        this.created.push(id)
      }
    }
  }
}

/**
 * Wires up a Yjs doc, a `viewsState` map and a `FakeWall` exactly like the main
 * process does, including the synchronous `observeDeep` observer that re-lays
 * the wall out (`updateViewsFromStateDoc`).
 */
function setupWall(cols: number, rows: number) {
  const doc = new Y.Doc()
  const viewsState = doc.getMap<Y.Map<string | undefined>>('views')
  const wall = new FakeWall(cols, rows)

  function updateViewsFromStateDoc() {
    const viewContentMap: ViewContentMap = new Map()
    for (const [key, viewData] of viewsState) {
      const streamId = viewData.get('streamId')
      if (streamId === undefined || streamId === '') {
        continue
      }
      // The streamId doubles as the content url in these tests.
      viewContentMap.set(key, { url: streamId, kind: 'video' })
    }
    wall.setViews(viewContentMap)
  }

  const ctx: GridResizeContext = {
    viewsState,
    transact: (fn) => doc.transact(fn),
    getCols: () => wall.cols,
    getRows: () => wall.rows,
    setGridSize: (c, r) => wall.setGridSize(c, r),
  }

  return { doc, viewsState, wall, updateViewsFromStateDoc, ctx }
}

/** Seeds `viewsState` with a full grid; `streams` maps cell index -> streamId. */
function seedAssignments(
  viewsState: Y.Map<Y.Map<string | undefined>>,
  cols: number,
  rows: number,
  streams: Record<number, string>,
) {
  viewsState.doc!.transact(() => {
    for (let i = 0; i < cols * rows; i++) {
      const data = new Y.Map<string | undefined>()
      data.set('streamId', streams[i])
      viewsState.set(String(i), data)
    }
  })
}

describe('applyGridResize', () => {
  it('preserves the running view when the grid grows (issue #15)', () => {
    const { viewsState, wall, updateViewsFromStateDoc, ctx } = setupWall(2, 2)

    // 2x2 grid with a single stream assigned to cell 3 (x=1, y=1).
    seedAssignments(viewsState, 2, 2, { 3: 'stream-a' })

    // Initial layout: exactly one view is created for the stream.
    updateViewsFromStateDoc()
    const initialId = wall.live.get('stream-a')
    expect(initialId).toBeDefined()
    expect(wall.created).toEqual([initialId])

    // Attach the synchronous observer, mirroring the main process.
    viewsState.observeDeep(updateViewsFromStateDoc)

    // Grow to 3x3: remapGridAssignments moves the stream from cell 3 to cell 4.
    applyGridResize(ctx, 3, 3)

    // The view must be reused, not destroyed and reloaded. Before the fix the
    // observer fired mid-transact against the stale 2x2 config, cell 4 produced
    // no box, and the view was destroyed then recreated (a full reload).
    expect(wall.destroyed).toEqual([])
    expect(wall.created).toEqual([initialId])
    expect(wall.live.get('stream-a')).toBe(initialId)
    // The stream really did move to cell 4 of the new grid.
    expect(viewsState.get('4')?.get('streamId')).toBe('stream-a')
    expect(wall.cols).toBe(3)
    expect(wall.rows).toBe(3)
  })

  it('applies the new grid size before the transact observer runs', () => {
    const doc = new Y.Doc()
    const viewsState = doc.getMap<Y.Map<string | undefined>>('views')
    seedAssignments(viewsState, 2, 2, { 3: 'stream-a' })

    let cols = 2
    let rows = 2
    const observedDims: Array<[number, number]> = []
    // Runs synchronously at the end of transact, like updateViewsFromStateDoc.
    viewsState.observeDeep(() => observedDims.push([cols, rows]))

    const ctx: GridResizeContext = {
      viewsState,
      transact: (fn) => doc.transact(fn),
      getCols: () => cols,
      getRows: () => rows,
      setGridSize: (c, r) => {
        cols = c
        rows = r
      },
    }

    applyGridResize(ctx, 3, 3)

    expect(observedDims.length).toBeGreaterThan(0)
    for (const dims of observedDims) {
      expect(dims).toEqual([3, 3])
    }
  })

  it('keeps each stream at its (x, y) position when the grid grows', () => {
    const { viewsState, ctx } = setupWall(2, 2)
    // cell 1 = (x=1, y=0); cell 2 = (x=0, y=1).
    seedAssignments(viewsState, 2, 2, { 1: 'stream-a', 2: 'stream-b' })

    applyGridResize(ctx, 4, 4)

    // (1,0) -> 4*0 + 1 = 1; (0,1) -> 4*1 + 0 = 4.
    expect(viewsState.get('1')?.get('streamId')).toBe('stream-a')
    expect(viewsState.get('4')?.get('streamId')).toBe('stream-b')
  })

  it('drops and destroys a stream that falls outside a shrunk grid', () => {
    const { viewsState, wall, updateViewsFromStateDoc, ctx } = setupWall(3, 3)
    // cell 8 = (x=2, y=2), only reachable in a 3x3 (or larger) grid.
    seedAssignments(viewsState, 3, 3, { 8: 'stream-a' })

    updateViewsFromStateDoc()
    const initialId = wall.live.get('stream-a')
    expect(initialId).toBeDefined()

    viewsState.observeDeep(updateViewsFromStateDoc)

    // Shrink to 2x2: (2,2) no longer exists, so the stream is dropped.
    applyGridResize(ctx, 2, 2)

    expect(wall.destroyed).toEqual([initialId])
    expect(wall.live.has('stream-a')).toBe(false)
    // No cell in the new 2x2 grid references the dropped stream.
    for (let i = 0; i < 4; i++) {
      expect(viewsState.get(String(i))?.get('streamId')).toBeUndefined()
    }
  })

  it('rebuilds viewsState to exactly cover the new grid', () => {
    const { viewsState, ctx } = setupWall(2, 2)
    seedAssignments(viewsState, 2, 2, {})

    applyGridResize(ctx, 3, 2)

    expect(
      [...viewsState.keys()].sort((a, b) => Number(a) - Number(b)),
    ).toEqual(['0', '1', '2', '3', '4', '5'])
  })

  it('clamps requested dimensions into the valid range and returns them', () => {
    const { viewsState, ctx } = setupWall(2, 2)
    seedAssignments(viewsState, 2, 2, {})

    const applied = applyGridResize(ctx, 0, 999)

    expect(applied).toEqual({ cols: 1, rows: GRID_MAX })
    expect(viewsState.size).toBe(1 * GRID_MAX)
  })

  it('does not resurrect a stale viewsState key left over from a larger grid (issue #17)', () => {
    // The true current grid is 3x1. A key like "17" can only be a leftover
    // from some previous, larger grid config that was never pruned (e.g. an
    // 8x8 wall) - it has no meaning under the current 3x1 dimensions.
    const { viewsState, wall, ctx } = setupWall(3, 1)
    seedAssignments(viewsState, 3, 1, { 0: 'stream-a' })
    viewsState.doc!.transact(() => {
      const ghost = new Y.Map<string | undefined>()
      ghost.set('streamId', 'ghost')
      viewsState.set('17', ghost)
    })

    // Grow to 6x6: naively reading idx=17 via oldCols=3 gives (x=2, y=5),
    // which fits inside 6x6 and would revive the ghost at cell 32.
    applyGridResize(ctx, 6, 6)

    expect(wall.live.has('ghost')).toBe(false)
    for (const [, viewData] of viewsState) {
      expect(viewData.get('streamId')).not.toBe('ghost')
    }
    expect(viewsState.get('0')?.get('streamId')).toBe('stream-a')
  })
})
