import { render } from 'preact'
import { act } from 'preact/test-utils'
import {
  asCellIdx,
  asViewId,
  type CellIdx,
  type ViewId,
  type ViewState,
} from 'streamwall-shared'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { hotkeyTriggers } from '../hotkeyLabel.ts'
import type { ViewInfo } from '../streamwallState.tsx'
import { useControlHotkeys } from './useControlHotkeys.ts'

const useHotkeysMock = vi.hoisted(() => vi.fn())
vi.mock('react-hotkeys-hook', () => ({
  useHotkeys: useHotkeysMock,
}))

let container: HTMLDivElement | undefined

afterEach(() => {
  if (container) {
    act(() => render(null, container!))
    container.remove()
    container = undefined
  }
  useHotkeysMock.mockClear()
})

/** Collects `[cellIndex, viewInfo]` pairs into the cell-keyed map (#507). */
function cellMap(entries: [number, ViewInfo][]): Map<CellIdx, ViewInfo> {
  return new Map(entries.map(([idx, info]) => [asCellIdx(idx), info]))
}

function makeViewInfo(
  id: number,
  cells: number[],
  overrides: Partial<ViewInfo> = {},
): ViewInfo {
  const spaces = cells.map(asCellIdx)
  const state: ViewState = {
    state: {
      displaying: {
        running: {
          playback: 'playing',
          video: 'normal',
          audio: 'muted',
          pause: 'unpaused',
          swap: 'idle',
        },
      },
    },
    context: {
      id: asViewId(id),
      content: null,
      info: null,
      pos: { x: 0, y: 0, width: 1, height: 1, spaces },
      error: null,
      volume: 1,
    },
  }
  return {
    state,
    isListening: false,
    isBackgroundListening: false,
    isBlurred: false,
    isPaused: false,
    volume: 1,
    spaces,
    ...overrides,
  }
}

function renderHotkeys(stateIdxMap: Map<CellIdx, ViewInfo>) {
  const handleSetListening = vi.fn<(viewId: ViewId, on: boolean) => void>()
  const handleSetBlurred = vi.fn<(viewId: ViewId, on: boolean) => void>()
  function Probe() {
    useControlHotkeys({
      stateIdxMap,
      focusedInputIdx: undefined,
      role: 'operator',
      handleSetListening,
      handleSetBlurred,
      setStreamCensored: () => {},
      handleSwapView: () => {},
      undoManager: undefined,
    })
    return null
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    render(<Probe />, container!)
  })
  return { handleSetListening, handleSetBlurred }
}

/**
 * Invokes the handler registered for the hotkey layer bound to `prefix`, as if
 * `${prefix}+${key}` had been pressed.
 */
function pressHotkey(prefix: string, key: string) {
  const expected = hotkeyTriggers.map((t) => `${prefix}+${t}`).join(',')
  const call = useHotkeysMock.mock.calls.find(([keys]) => keys === expected)
  if (!call) {
    throw new Error(`no hotkey layer registered for prefix ${prefix}`)
  }
  const handler = call[1] as (
    ev: { preventDefault: () => void },
    opts: { hotkey: string },
  ) => void
  act(() => {
    handler({ preventDefault: () => {} }, { hotkey: `${prefix}+${key}` })
  })
}

describe('useControlHotkeys view addressing (#470)', () => {
  // Cell index and view id are independent axes: `stateIdxMap` is keyed by grid
  // cell, while `viewId` is the Electron `webContents.id`. The fixtures below
  // deliberately keep the two apart so a regression cannot pass by coincidence.
  test('audio-listen hotkey dispatches the view id, not the cell index', () => {
    const stateIdxMap = cellMap([
      [0, makeViewInfo(42, [0])],
      [1, makeViewInfo(43, [1])],
    ])
    const { handleSetListening } = renderHotkeys(stateIdxMap)

    pressHotkey('alt', hotkeyTriggers[1])

    expect(handleSetListening).toHaveBeenCalledWith(43, true)
  })

  test('audio-listen hotkey toggles off using the view id', () => {
    const stateIdxMap = cellMap([
      [0, makeViewInfo(42, [0], { isListening: true })],
    ])
    const { handleSetListening } = renderHotkeys(stateIdxMap)

    pressHotkey('alt', hotkeyTriggers[0])

    expect(handleSetListening).toHaveBeenCalledWith(42, false)
  })

  test('second audio layer offsets by 20 cells and still sends the view id', () => {
    const stateIdxMap = cellMap([
      [hotkeyTriggers.length, makeViewInfo(77, [hotkeyTriggers.length])],
    ])
    const { handleSetListening } = renderHotkeys(stateIdxMap)

    pressHotkey('alt+ctrl', hotkeyTriggers[0])

    expect(handleSetListening).toHaveBeenCalledWith(77, true)
  })

  test('blur hotkey dispatches the view id, not the cell index', () => {
    const stateIdxMap = cellMap([
      [0, makeViewInfo(42, [0])],
      [1, makeViewInfo(43, [1], { isBlurred: true })],
    ])
    const { handleSetBlurred } = renderHotkeys(stateIdxMap)

    pressHotkey('alt+shift', hotkeyTriggers[1])

    expect(handleSetBlurred).toHaveBeenCalledWith(43, false)
  })

  test('second blur layer offsets by 20 cells and still sends the view id', () => {
    const stateIdxMap = cellMap([
      [
        hotkeyTriggers.length + 2,
        makeViewInfo(88, [hotkeyTriggers.length + 2]),
      ],
    ])
    const { handleSetBlurred } = renderHotkeys(stateIdxMap)

    pressHotkey('alt+ctrl+shift', hotkeyTriggers[2])

    expect(handleSetBlurred).toHaveBeenCalledWith(88, true)
  })

  test('hotkeys for empty cells dispatch nothing', () => {
    const { handleSetListening, handleSetBlurred } = renderHotkeys(cellMap([]))

    pressHotkey('alt', hotkeyTriggers[3])
    pressHotkey('alt+shift', hotkeyTriggers[3])

    expect(handleSetListening).not.toHaveBeenCalled()
    expect(handleSetBlurred).not.toHaveBeenCalled()
  })
})
