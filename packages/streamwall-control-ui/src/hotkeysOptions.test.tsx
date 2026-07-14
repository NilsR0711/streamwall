import { render } from 'preact'
import { act } from 'preact/test-utils'
import type { StreamDelayStatus } from 'streamwall-shared'
import { afterEach, describe, expect, test, vi } from 'vitest'
import * as Y from 'yjs'
import type { StreamwallConnection } from './index.tsx'
import { ControlUI } from './index.tsx'

// react-icons renders through preact/compat's Context.Consumer, which
// currently crashes under this package's happy-dom test environment
// (unrelated to the hotkey wiring under test here) - stub the icons out so
// the component can render far enough to register its hotkeys.
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

function renderControlUI(): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)

  const delayState: StreamDelayStatus = {
    isConnected: true,
    delaySeconds: 0,
    restartSeconds: 0,
    isCensored: false,
    isStreamRunning: true,
    startTime: 0,
    state: 'idle',
  }

  const connection: StreamwallConnection = {
    isConnected: true,
    role: 'operator',
    send: () => {},
    sharedState: { views: {} },
    stateDoc: new Y.Doc(),
    config: undefined,
    streams: [],
    customStreams: [],
    views: [],
    stateIdxMap: new Map(),
    delayState,
    authState: undefined,
  }

  act(() => {
    render(<ControlUI connection={connection} />, container!)
  })
  return container
}

describe('alt+<n> listen-toggle hotkey', () => {
  test('enables the hotkey while a grid input is focused via the v5 enableOnFormTags option', () => {
    renderControlUI()

    const listenToggleCall = useHotkeysMock.mock.calls.find(
      ([keys]) =>
        typeof keys === 'string' &&
        keys
          .split(',')
          .every((k) => k.startsWith('alt+') && !k.includes('shift')),
    )

    expect(listenToggleCall).toBeDefined()
    const options = listenToggleCall?.[2]
    expect(options).toEqual({ enableOnFormTags: true })
  })
})
