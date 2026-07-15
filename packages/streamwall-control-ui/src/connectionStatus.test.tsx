import { render } from 'preact'
import { act } from 'preact/test-utils'
import type { StreamDelayStatus } from 'streamwall-shared'
import { afterEach, describe, expect, test, vi } from 'vitest'
import * as Y from 'yjs'
import type { StreamwallConnection } from './index.tsx'
import { ControlUI } from './index.tsx'

// react-icons renders through preact/compat's Context.Consumer, which
// currently crashes under this package's happy-dom test environment
// (unrelated to the connection status under test here) - stub the icons out
// so the component can render.
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
// react-hotkeys-hook calls into React internals that don't cooperate with
// this package's Preact/compat test environment (unrelated to the
// connection status under test here) - stub it out so the component can
// render.
vi.mock('react-hotkeys-hook', () => ({
  useHotkeys: () => {},
}))

let container: HTMLDivElement | undefined

afterEach(() => {
  if (container) {
    act(() => render(null, container!))
    container.remove()
    container = undefined
  }
})

function renderControlUI(isConnected: boolean): HTMLDivElement {
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
    isConnected,
    role: 'operator',
    send: () => {},
    sharedState: { views: {} },
    stateDoc: new Y.Doc(),
    config: undefined,
    streams: [],
    customStreams: [],
    views: [],
    fullscreenViewIdx: null,
    stateIdxMap: new Map(),
    delayState,
    authState: undefined,
    layoutPresets: [],
    favorites: [],
    dataSourceHealth: [],
  }

  act(() => {
    render(<ControlUI connection={connection} />, container!)
  })
  return container
}

describe('connection status text', () => {
  test('renders the connected state in English', () => {
    const container = renderControlUI(true)
    expect(container.querySelector('.status')?.textContent).toBe(
      'connected · operator',
    )
  })

  test('renders the connecting state in English', () => {
    const container = renderControlUI(false)
    expect(container.querySelector('.status')?.textContent).toBe(
      'connecting... · operator',
    )
  })
})
