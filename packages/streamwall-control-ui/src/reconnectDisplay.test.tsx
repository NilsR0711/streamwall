import { render } from 'preact'
import { act } from 'preact/test-utils'
import type {
  ConnectionStatus,
  StreamData,
  StreamDelayStatus,
  StreamWindowConfig,
} from 'streamwall-shared'
import { afterEach, describe, expect, test, vi } from 'vitest'
import * as Y from 'yjs'
import { ControlUI, type StreamwallConnection } from './index.tsx'

// react-icons renders through preact/compat's Context.Consumer, which
// currently crashes under this package's happy-dom test environment
// (unrelated to the markup under test here) - stub the icons out so the
// component's own rendering logic can be exercised in isolation.
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
  width: 1920,
  height: 1080,
  frameless: false,
  fullscreen: false,
  activeColor: '#f24d2e',
  backgroundColor: '#000000',
}

const streams: StreamData[] = [
  {
    _id: 'a',
    _dataSource: 'demo',
    kind: 'video',
    link: 'https://example.com/a',
    label: 'Stream A',
    status: 'Live',
  },
]

const delayState: StreamDelayStatus = {
  isConnected: true,
  delaySeconds: 0,
  restartSeconds: 0,
  isCensored: false,
  isStreamRunning: true,
  startTime: 0,
  state: 'idle',
}

function renderControlUI(
  connectionStatus: ConnectionStatus,
  { hasEverConnected }: { hasEverConnected: boolean },
): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)

  const connection: StreamwallConnection = {
    connectionStatus,
    role: hasEverConnected ? 'operator' : null,
    send: () => {},
    sharedState: { views: {} },
    stateDoc: new Y.Doc(),
    config: hasEverConnected ? config : undefined,
    streams: hasEverConnected ? streams : [],
    customStreams: [],
    views: [],
    stateIdxMap: new Map(),
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

describe('reconnect display (issue #37)', () => {
  test('a first-ever connect shows the plain loading state, no banner', () => {
    const el = renderControlUI('connecting', { hasEverConnected: false })
    expect(el.querySelector('.grid')).toBeNull()
    expect(el.querySelector('.connection-status-banner')).toBeNull()
    expect(el.textContent).toContain('loading...')
  })

  test('a connected wall shows the grid and stream list without a banner', () => {
    const el = renderControlUI('connected', { hasEverConnected: true })
    expect(el.querySelector('.grid')).not.toBeNull()
    expect(el.querySelector('.connection-status-banner')).toBeNull()
    expect(el.textContent).toContain('Stream A')
  })

  test('losing the connection after a successful load keeps the grid and stream list mounted, dimmed, with a banner', () => {
    const el = renderControlUI('reconnecting', { hasEverConnected: true })
    expect(el.querySelector('.grid')).not.toBeNull()
    expect(el.textContent).toContain('Stream A')
    expect(el.textContent).not.toContain('loading...')
    const banner = el.querySelector('.connection-status-banner')
    expect(banner).not.toBeNull()
    expect(banner?.className).toContain('warning')
  })

  test('an unauthorized session keeps the last-known wall visible with a severe banner', () => {
    const el = renderControlUI('unauthorized', { hasEverConnected: true })
    expect(el.querySelector('.grid')).not.toBeNull()
    const banner = el.querySelector('.connection-status-banner')
    expect(banner?.className).toContain('severe')
  })
})
