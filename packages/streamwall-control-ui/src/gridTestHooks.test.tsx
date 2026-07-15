import { render } from 'preact'
import { act } from 'preact/test-utils'
import type { StreamDelayStatus, StreamWindowConfig } from 'streamwall-shared'
import { afterEach, describe, expect, test, vi } from 'vitest'
import * as Y from 'yjs'
import { ControlUI, type StreamwallConnection } from './index.tsx'

// react-icons renders through preact/compat's Context.Consumer, which
// currently crashes under this package's happy-dom test environment
// (unrelated to the test hooks under test here) - stub the icons out so
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
    config,
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

// The E2E suite (packages/streamwall-control-e2e) drives these landmarks via
// `data-testid` rather than the styled-components class names used for
// layout/CSS, so a rendering refactor can't silently break the tests
// (issue #344).
describe('E2E test hooks', () => {
  test('exposes a stable data-testid on the grid container', () => {
    const root = renderControlUI(true)
    expect(root.querySelector('[data-testid="grid"]')).not.toBeNull()
  })

  test('exposes a stable data-testid on the header connection status', () => {
    const root = renderControlUI(true)
    const status = root.querySelector(
      '[data-testid="header-connection-status"]',
    )
    expect(status?.textContent).toBe('connected · operator')
  })
})
