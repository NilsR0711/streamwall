import { render } from 'preact'
import { act } from 'preact/test-utils'
import type {
  DisconnectReason,
  StreamData,
  StreamDelayStatus,
  StreamWindowConfig,
} from 'streamwall-shared'
import { afterEach, describe, expect, test, vi } from 'vitest'
import * as Y from 'yjs'
import { ControlUI, type StreamwallConnection } from './index.tsx'

// react-icons renders through preact/compat's Context.Consumer, which
// currently crashes under this package's happy-dom test environment
// (unrelated to the disconnect rendering under test here) - stub the icons
// out so ControlUI's own rendering can be exercised in isolation.
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

function renderControlUI(
  connectionOverrides: Partial<StreamwallConnection>,
): HTMLDivElement {
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
    fullscreenViewIdx: null,
    stateIdxMap: new Map(),
    delayState,
    authState: undefined,
    layoutPresets: [],
    favorites: [],
    dataSourceHealth: [],
    ...connectionOverrides,
  }

  act(() => {
    render(<ControlUI connection={connection} />, container!)
  })
  return container
}

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

const stream: StreamData = {
  _id: 'abc',
  _dataSource: 'custom',
  kind: 'video',
  link: 'https://example.com/abc',
  label: 'Example stream',
}

// A brief websocket blip previously wiped `streamwallState` in
// streamwall-control-client, which unmounted the grid (`cols`/`rows` go
// null) and made the sidebar show "loading..." (issue #37). These tests lock
// in the fix: a `StreamwallConnection` that was connected before (`role` is
// set) keeps rendering its last-known content, dimmed, instead of blanking.
describe('rendering across a disconnect', () => {
  test('keeps the grid mounted with its last-known assignment while reconnecting', () => {
    const root = renderControlUI({
      isConnected: false,
      role: 'operator',
      config,
      streams: [stream],
      sharedState: { views: { '0': { streamId: 'abc' } } },
    })

    const grid = root.querySelector('.grid')
    expect(grid, 'grid should stay mounted during a reconnect').not.toBeNull()

    const cellInput = grid!.querySelector('input') as HTMLInputElement | null
    expect(cellInput?.value).toBe('abc')
  })

  test('dims the grid/list container while disconnected', () => {
    const root = renderControlUI({
      isConnected: false,
      role: 'operator',
      config,
      streams: [stream],
    })

    const containers = [...root.querySelectorAll('div')].filter(
      (el) => getComputedStyle(el).opacity === '0.5',
    )
    expect(containers.length).toBeGreaterThan(0)
  })

  test('keeps showing the last-known stream list instead of "loading..."', () => {
    const root = renderControlUI({
      isConnected: false,
      role: 'operator',
      config,
      streams: [stream],
    })

    expect(root.textContent).toContain('Example stream')
    expect(root.textContent).not.toContain('loading...')
  })

  test('shows "loading..." only before any state has ever arrived', () => {
    const root = renderControlUI({
      isConnected: false,
      role: null,
      config: undefined,
      streams: [],
    })

    expect(root.textContent).toContain('loading...')
    expect(root.querySelector('.grid')).toBeNull()
  })

  test.each<[DisconnectReason | null | undefined, string]>([
    ['unauthorized', 'Session invalid'],
    ['streamwall-disconnected', 'Streamwall app disconnected'],
    [null, 'Connection lost'],
    [undefined, 'Connection lost'],
  ])('shows the right banner for reason %p', (reason, expectedText) => {
    const root = renderControlUI({
      isConnected: false,
      disconnectReason: reason,
      role: 'operator',
      config,
      streams: [stream],
    })

    expect(root.querySelector('[role="status"]')?.textContent).toContain(
      expectedText,
    )
  })

  test('renders no banner while connected', () => {
    const root = renderControlUI({ isConnected: true, disconnectReason: null })
    expect(root.querySelector('[role="status"]')).toBeNull()
  })
})
