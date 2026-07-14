import { render } from 'preact'
import { act } from 'preact/test-utils'
import type {
  StreamData,
  StreamDelayStatus,
  StreamWindowConfig,
  StreamwallRole,
} from 'streamwall-shared'
import { afterEach, describe, expect, test, vi } from 'vitest'
import * as Y from 'yjs'
import {
  ControlUI,
  type StreamwallConnection,
  type ViewInfo,
} from './index.tsx'

// react-icons renders through preact/compat's Context.Consumer, which
// currently crashes under this package's happy-dom test environment
// (unrelated to the hotkey gating under test here) - stub the icons out so
// ControlUI's own rendering can be exercised in isolation.
vi.mock('react-icons/fa', () => ({
  FaExchangeAlt: () => null,
  FaExclamationTriangle: () => null,
  FaRedoAlt: () => null,
  FaRegLifeRing: () => null,
  FaRegWindowMaximize: () => null,
  FaSyncAlt: () => null,
  FaVideoSlash: () => null,
  FaVolumeUp: () => null,
}))
vi.mock('react-icons/md', () => ({
  MdOutlineStayCurrentLandscape: () => null,
  MdOutlineStayCurrentPortrait: () => null,
}))

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

const config: StreamWindowConfig = {
  cols: 2,
  rows: 1,
  width: 800,
  height: 400,
  frameless: false,
  fullscreen: false,
  activeColor: '#fff',
  backgroundColor: '#000',
}

function makeStream(id: string, label: string): StreamData {
  return {
    _id: id,
    _dataSource: 'custom',
    kind: 'video',
    link: `https://example.com/${id}`,
    label,
  }
}

function renderControlUI(role: StreamwallRole | null): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)

  const stateDoc = new Y.Doc()
  stateDoc.transact(() => {
    const viewsMap = stateDoc.getMap<Y.Map<string | undefined>>('views')
    const box0 = new Y.Map<string | undefined>()
    box0.set('streamId', 'stream-a')
    viewsMap.set('0', box0)
    const box1 = new Y.Map<string | undefined>()
    box1.set('streamId', 'stream-b')
    viewsMap.set('1', box1)
  })

  const delayState: StreamDelayStatus = {
    isConnected: true,
    delaySeconds: 0,
    restartSeconds: 0,
    isCensored: false,
    isStreamRunning: true,
    startTime: 0,
    state: 'idle',
  }

  const stateIdxMap = new Map<number, ViewInfo>([
    [0, { spaces: [0] } as ViewInfo],
    [1, { spaces: [1] } as ViewInfo],
  ])

  const connection: StreamwallConnection = {
    isConnected: true,
    role,
    send: () => {},
    sharedState: {
      views: {
        '0': { streamId: 'stream-a' },
        '1': { streamId: 'stream-b' },
      },
    },
    stateDoc,
    config,
    streams: [
      makeStream('stream-a', 'Stream A'),
      makeStream('stream-b', 'Stream B'),
    ],
    customStreams: [],
    views: [],
    stateIdxMap,
    delayState,
    authState: undefined,
    layoutPresets: [],
    dataSourceHealth: [],
  }

  act(() => {
    render(<ControlUI connection={connection} />, container!)
  })
  return container
}

function focusCell0(root: HTMLDivElement) {
  const grid = root.querySelector('.grid') as HTMLElement
  const cell0Input = grid.querySelectorAll('input')[0]
  // preact/compat remaps `onFocus` to a native `focusin` listener (it
  // bubbles, unlike `focus`), so that's the event that must be dispatched
  // here for GridInput's `handleFocus` to fire.
  act(() => {
    cell0Input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
  })
}

function invokeAltSHotkey() {
  // `useHotkeys` re-registers on every render with a fresh closure over
  // `focusedInputIdx` (it's a dependency), so `mock.calls` accumulates one
  // entry per render. Take the last one so the callback closes over the
  // post-focus state rather than the initial (unfocused) render.
  const altSCalls = useHotkeysMock.mock.calls.filter(
    ([keys]) => keys === 'alt+s',
  )
  expect(altSCalls.length).toBeGreaterThan(0)
  const [, callback] = altSCalls[altSCalls.length - 1] as [string, () => void]
  act(() => {
    callback()
  })
}

// Locks in the fix for issue #305: the `alt+s` hotkey called `handleSwapView`
// with no `roleCan(role, 'mutate-state-doc')` gate, unlike the on-screen
// "Swap stream" button in GridControls. A `monitor`-role client could press
// alt+s while a grid input is focused and visibly enter "swap mode" even
// though they have no ability to complete the swap. `handleSwapView` blurs
// the currently focused element as one of its first effects, so spying on
// `document.body.blur` (the activeElement in this test environment)
// indicates whether the guarded callback executed.
describe('alt+s swap hotkey role gating', () => {
  test('does not enter swap mode for a monitor role', () => {
    const root = renderControlUI('monitor')
    focusCell0(root)
    const blurSpy = vi.spyOn(document.body, 'blur')

    invokeAltSHotkey()

    expect(blurSpy).not.toHaveBeenCalled()
    blurSpy.mockRestore()
  })

  test('enters swap mode for an operator role', () => {
    const root = renderControlUI('operator')
    focusCell0(root)
    const blurSpy = vi.spyOn(document.body, 'blur')

    invokeAltSHotkey()

    expect(blurSpy).toHaveBeenCalled()
    blurSpy.mockRestore()
  })
})
