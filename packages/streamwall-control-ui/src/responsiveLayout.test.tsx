import { render } from 'preact'
import { act } from 'preact/test-utils'
import type { StreamDelayStatus } from 'streamwall-shared'
import { afterEach, describe, expect, test, vi } from 'vitest'
import * as Y from 'yjs'
import { ControlUI, type StreamwallConnection } from './index.tsx'

// react-icons renders through preact/compat's Context.Consumer, which currently
// crashes under this package's happy-dom test environment (unrelated to the
// layout under test here) - stub the icons out so ControlUI's own rendering can
// be exercised in isolation.
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
// react-hotkeys-hook resolves its own copy of `react` (bypassing this package's
// `react` -> `preact/compat` test alias), which crashes under happy-dom - stub
// it out so the component's own rendering logic can be exercised in isolation.
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
    layoutPresets: [],
    dataSourceHealth: [],
  }

  act(() => {
    render(<ControlUI connection={connection} />, container!)
  })
  return container
}

// The responsive layout stacks the wall preview and the stream list below each
// other on narrow screens via a CSS media query (see #81). That media query
// targets the shell and its two regions by class name, so the DOM contract they
// rely on is what this test guards - if the shell or a region is renamed or
// removed, the responsive stacking silently breaks.
describe('responsive app shell', () => {
  test('renders a shell containing the wall and stream-list regions', () => {
    const root = renderControlUI()

    const shell = root.querySelector('.app-shell')
    expect(shell, 'app shell container is missing').not.toBeNull()
    expect(
      shell!.querySelector('.grid-container'),
      'wall region is missing from the shell',
    ).not.toBeNull()
    expect(
      shell!.querySelector('.stream-list'),
      'stream-list region is missing from the shell',
    ).not.toBeNull()
  })
})
