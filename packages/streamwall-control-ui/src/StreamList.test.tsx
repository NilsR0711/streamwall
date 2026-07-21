import { render } from 'preact'
import { act } from 'preact/test-utils'
import type { StreamData, StreamDelayStatus } from 'streamwall-shared'
import { afterEach, describe, expect, test, vi } from 'vitest'
import * as Y from 'yjs'
import { ControlUI, type StreamwallConnection } from './index.tsx'

// react-icons renders through preact/compat's Context.Consumer, which currently
// crashes under this package's happy-dom test environment (unrelated to the
// list rendering under test here) - stub the icons out so ControlUI's own
// rendering can be exercised in isolation.
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

function makeStream(id: string): StreamData {
  return {
    _id: id,
    _dataSource: 'test',
    kind: 'video',
    link: `https://example.com/${id}`,
  }
}

function makeConnection(
  streams: StreamData[],
  favorites: string[] = [],
): StreamwallConnection {
  const delayState: StreamDelayStatus = {
    isConnected: true,
    delaySeconds: 0,
    restartSeconds: 0,
    isCensored: false,
    isStreamRunning: true,
    startTime: 0,
    state: 'idle',
  }

  return {
    isConnected: true,
    role: 'operator',
    send: () => {},
    sharedState: { views: {} },
    stateDoc: new Y.Doc(),
    config: undefined,
    streams,
    customStreams: [],
    views: [],
    fullscreenViewIdx: null,
    stateIdxMap: new Map(),
    delayState,
    authState: undefined,
    layoutPresets: [],
    favorites,
    dataSourceHealth: [],
  }
}

function renderControlUI(streams: StreamData[]): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    render(<ControlUI connection={makeConnection(streams)} />, container!)
  })
  return container
}

function findIdNode(root: HTMLDivElement, id: string): Element | undefined {
  return [
    ...root.querySelectorAll('.stream-list div, .stream-list button'),
  ].find((el) => el.children.length === 0 && el.textContent === id)
}

// The app re-renders <ControlUI connection={...} /> with a fresh `connection`
// object on every state message (they arrive continuously - see #39). If a
// list component is redeclared inside ControlUI's body, each such re-render
// produces a brand-new component reference at that position, forcing Preact
// to unmount and remount the whole stream-list subtree even though nothing
// about the rendered rows actually changed.
describe('stream list identity across ControlUI re-renders', () => {
  test('does not remount stream rows when the app re-renders with a fresh connection object', () => {
    const root = renderControlUI([
      makeStream('stream-a'),
      makeStream('stream-b'),
    ])
    const before = findIdNode(root, 'stream-a')
    expect(
      before,
      'expected to find a rendered row for stream-a',
    ).not.toBeUndefined()

    act(() => {
      render(
        <ControlUI
          connection={makeConnection([
            makeStream('stream-a'),
            makeStream('stream-b'),
          ])}
        />,
        root,
      )
    })

    const after = findIdNode(root, 'stream-a')
    expect(
      after,
      'expected to still find a rendered row for stream-a',
    ).not.toBeUndefined()
    expect(after).toBe(before)
  })
})

describe('favorites', () => {
  test('surfaces a favorited stream under a Favorites heading with the correct count', () => {
    const stream = makeStream('stream-a')
    container = document.createElement('div')
    document.body.appendChild(container)
    act(() => {
      render(
        <ControlUI connection={makeConnection([stream], [stream.link])} />,
        container!,
      )
    })

    const heading = [...container.querySelectorAll('h3')].find((h) =>
      h.textContent?.startsWith('Favorites'),
    )
    expect(heading).not.toBeUndefined()
    expect(heading?.textContent).toContain('1')
  })

  test('sends add-favorite when starring a stream that is not yet a favorite', () => {
    const stream = makeStream('stream-a')
    const connection = makeConnection([stream])
    const send = vi.fn()
    connection.send = send
    container = document.createElement('div')
    document.body.appendChild(container)
    act(() => {
      render(<ControlUI connection={connection} />, container!)
    })

    const button = container.querySelector(
      '.favorite-star',
    ) as HTMLButtonElement
    act(() => {
      button.click()
    })

    const lastCall = send.mock.calls.at(-1)
    expect(lastCall?.[0]).toEqual({
      type: 'add-favorite',
      url: stream.link,
    })
  })

  test('sends remove-favorite when un-starring an already-favorited stream', () => {
    const stream = makeStream('stream-a')
    const connection = makeConnection([stream], [stream.link])
    const send = vi.fn()
    connection.send = send
    container = document.createElement('div')
    document.body.appendChild(container)
    act(() => {
      render(<ControlUI connection={connection} />, container!)
    })

    const button = container.querySelector(
      '.favorite-star',
    ) as HTMLButtonElement
    act(() => {
      button.click()
    })

    const lastCall = send.mock.calls.at(-1)
    expect(lastCall?.[0]).toEqual({
      type: 'remove-favorite',
      url: stream.link,
    })
  })
})
