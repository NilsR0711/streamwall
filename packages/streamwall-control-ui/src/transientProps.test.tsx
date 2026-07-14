import { render } from 'preact'
import { act } from 'preact/test-utils'
import type { StreamDelayStatus } from 'streamwall-shared'
import { afterEach, describe, expect, test, vi } from 'vitest'
import * as Y from 'yjs'
import type { StreamwallConnection } from './index.tsx'
import { ControlUI } from './index.tsx'

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
// react-hotkeys-hook resolves its own copy of `react` (bypassing this
// package's `react` -> `preact/compat` test alias), which crashes under
// happy-dom with an "Invalid hook call" error unrelated to the markup under
// test here - stub it out so the component's own rendering logic can be
// exercised in isolation.
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

// styled-components v6 forwards any non-`$`-prefixed custom prop that isn't a
// recognized HTML attribute straight onto the DOM node. Each of these is a
// custom prop consumed by a styled component in this file (see #152) and must
// never show up as a literal attribute in the rendered markup.
const leakedPropNames = [
  'direction',
  'flex',
  'gap',
  'scroll',
  'minheight',
  'isconnected',
  'isactive',
  'activecolor',
]

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

describe('styled-component custom props (transient props)', () => {
  test('never leak onto rendered DOM elements as literal attributes', () => {
    const root = renderControlUI()

    for (const el of root.querySelectorAll('*')) {
      for (const propName of leakedPropNames) {
        expect(
          el.hasAttribute(propName),
          `<${el.tagName.toLowerCase()}> unexpectedly has a "${propName}" attribute`,
        ).toBe(false)
      }
    }
  })
})
