import { render } from 'preact'
import { act } from 'preact/test-utils'
import {
  asCellIdx,
  asViewId,
  type CellIdx,
  type StreamwallState,
  type StreamWindowConfig,
  type ViewId,
  type ViewState,
} from 'streamwall-shared'
import { afterEach, describe, expect, test } from 'vitest'
import { useStreamwallState, type ViewInfo } from './streamwallState.tsx'

let container: HTMLDivElement | undefined

afterEach(() => {
  if (container) {
    act(() => render(null, container!))
    container.remove()
    container = undefined
  }
})

const config: StreamWindowConfig = {
  cols: 2,
  rows: 1,
  width: 200,
  height: 100,
  frameless: false,
  fullscreen: false,
  activeColor: '#0f0',
  backgroundColor: '#000',
}

function makeViewState(
  id: number,
  cells: number[],
  {
    audio = 'listening',
    pause = 'unpaused',
  }: {
    audio?: 'listening' | 'background' | 'muted'
    pause?: 'paused' | 'unpaused'
  } = {},
): ViewState {
  const spaces = cells.map(asCellIdx)
  return {
    state: {
      displaying: {
        running: {
          playback: 'playing',
          video: 'normal',
          audio,
          pause,
          swap: 'idle',
        },
      },
    },
    context: {
      id: asViewId(id),
      content: { url: `https://example.com/${id}`, kind: 'video' },
      info: null,
      pos: {
        x: 0,
        y: 0,
        width: 100 * spaces.length,
        height: 100,
        spaces,
      },
      error: null,
      volume: 0.5,
    },
  }
}

function makeState(views: ViewState[]): StreamwallState {
  return {
    identity: { role: 'admin' },
    config,
    streams: [],
    customStreams: [],
    views,
    fullscreenViewIdx: null,
    streamdelay: null,
    layoutPresets: [],
    favorites: [],
    dataSourceHealth: [],
  }
}

/** Renders the hook and hands the memoized result back to the test. */
function runHook(state: StreamwallState | undefined) {
  let result: ReturnType<typeof useStreamwallState> | undefined
  function Harness() {
    result = useStreamwallState(state)
    return null
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    render(<Harness />, container!)
  })
  return result!
}

describe('useStreamwallState', () => {
  test('derives isPaused for a view whose media playback is paused', () => {
    const { views, stateIdxMap } = runHook(
      makeState([makeViewState(1, [0], { pause: 'paused' })]),
    )

    expect(views[0]!.isPaused).toBe(true)
    expect(stateIdxMap.get(asCellIdx(0))!.isPaused).toBe(true)
  })

  test('leaves isPaused false while the view keeps playing', () => {
    const { views } = runHook(makeState([makeViewState(1, [0])]))

    expect(views[0]!.isPaused).toBe(false)
  })

  test('maps every occupied cell to the complete view info', () => {
    // A single view spanning two cells: both cells must resolve to the same,
    // fully populated `ViewInfo` - never a partially filled placeholder.
    const viewState = makeViewState(42, [0, 1])
    const { stateIdxMap, views } = runHook(makeState([viewState]))

    const expected: ViewInfo = {
      state: viewState,
      isListening: true,
      isBackgroundListening: false,
      isBlurred: false,
      isPaused: false,
      volume: 0.5,
      spaces: [asCellIdx(0), asCellIdx(1)],
    }
    expect(stateIdxMap.get(asCellIdx(0))).toEqual(expected)
    expect(stateIdxMap.get(asCellIdx(1))).toEqual(expected)
    // The map shares the entries with `views` instead of copying them, so the
    // two never drift apart.
    expect(stateIdxMap.get(asCellIdx(0))).toBe(views[0])
    expect(stateIdxMap.get(asCellIdx(1))).toBe(views[0])
  })

  test('lets the later view win a cell two views claim', () => {
    // The builder walks `views` in order and overwrites, so the last claimant
    // owns the cell. Pinned because it used to be an implicit consequence of
    // `Object.assign`-ing every view onto a shared placeholder.
    const first = makeViewState(1, [0, 1])
    const second = makeViewState(2, [1])
    const { stateIdxMap } = runHook(makeState([first, second]))

    expect(stateIdxMap.get(asCellIdx(0))!.state).toBe(first)
    expect(stateIdxMap.get(asCellIdx(1))!.state).toBe(second)
  })

  test('leaves unoccupied cells absent', () => {
    const { stateIdxMap } = runHook(makeState([makeViewState(7, [1])]))

    expect(stateIdxMap.has(asCellIdx(0))).toBe(false)
    expect(stateIdxMap.get(asCellIdx(1))?.state.context.id).toBe(asViewId(7))
  })

  test('returns an empty map before the first state arrives', () => {
    const { stateIdxMap, views } = runHook(undefined)

    expect(stateIdxMap.size).toBe(0)
    expect(views).toEqual([])
  })

  // Compile-time guards. These assert the *types* the builder produces, which
  // is what issue #507 is about: an untyped map made every entry `any`, and two
  // structurally identical `number` axes let a grid cell index stand in for a
  // stable view id (the #470 defect class).
  test('types the cell-index map at construction', () => {
    const { stateIdxMap } = runHook(makeState([makeViewState(1, [0])]))

    // @ts-expect-error - entries are complete `ViewInfo`s, not placeholders
    stateIdxMap.set(asCellIdx(0), {})
    // @ts-expect-error - the map is keyed by cell index, not by view id
    stateIdxMap.get(asViewId(0))
    expect(stateIdxMap.size).toBe(1)
  })

  test('keeps the view-id and cell-index axes apart', () => {
    const cellIdx: CellIdx = asCellIdx(3)
    const viewId: ViewId = asViewId(3)
    const takesViewId = (_id: ViewId) => undefined
    const takesCellIdx = (_idx: CellIdx) => undefined

    // @ts-expect-error - a grid cell index is not a stable view id
    takesViewId(cellIdx)
    // @ts-expect-error - a stable view id is not a grid cell index
    takesCellIdx(viewId)
    // @ts-expect-error - neither axis accepts a bare number
    takesViewId(3)
    expect(takesViewId(viewId)).toBeUndefined()
    expect(takesCellIdx(cellIdx)).toBeUndefined()
  })
})
