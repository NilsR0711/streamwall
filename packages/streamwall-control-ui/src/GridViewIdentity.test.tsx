import { render } from 'preact'
import { act } from 'preact/test-utils'
import type {
  StreamData,
  StreamDelayStatus,
  StreamWindowConfig,
} from 'streamwall-shared'
import { afterEach, describe, expect, test, vi } from 'vitest'
import * as Y from 'yjs'
import {
  ControlUI,
  type StreamwallConnection,
  type ViewInfo,
} from './index.tsx'

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

function makeStream(id: string): StreamData {
  return {
    _id: id,
    _dataSource: 'test',
    kind: 'video',
    link: `https://example.com/${id}`,
  }
}

function makeView(streamIdx: number, spaces: number[]): ViewInfo {
  return {
    state: {
      state: {
        displaying: {
          running: { playback: 'playing', video: 'normal', audio: 'muted' },
        },
      },
      context: {
        id: streamIdx,
        content: { url: `https://example.com/s${streamIdx}`, kind: 'video' },
        info: null,
        pos: { x: spaces[0] * 100, y: 0, width: 100, height: 100, spaces },
        error: null,
        volume: 1,
      },
    },
    isListening: false,
    isBackgroundListening: false,
    isBlurred: false,
    volume: 1,
    spaces,
  }
}

function makeConnection(viewCount: number): StreamwallConnection {
  const delayState: StreamDelayStatus = {
    isConnected: true,
    delaySeconds: 0,
    restartSeconds: 0,
    isCensored: false,
    isStreamRunning: true,
    startTime: 0,
    state: 'idle',
  }
  const config: StreamWindowConfig = {
    cols: viewCount,
    rows: 1,
    width: 100 * viewCount,
    height: 100,
    frameless: false,
    fullscreen: false,
    activeColor: '#0f0',
    backgroundColor: '#000',
  }

  const streams = Array.from({ length: viewCount }, (_, i) =>
    makeStream(`s${i}`),
  )
  const views = Array.from({ length: viewCount }, (_, i) => makeView(i, [i]))
  const stateIdxMap = new Map<number, ViewInfo>()
  views.forEach((v, i) => stateIdxMap.set(i, v))

  return {
    isConnected: true,
    role: 'operator',
    send: () => {},
    sharedState: {
      views: Object.fromEntries(
        streams.map((s, i) => [i, { streamId: s._id }]),
      ),
    },
    stateDoc: new Y.Doc(),
    config,
    streams,
    customStreams: [],
    views,
    stateIdxMap,
    delayState,
    authState: undefined,
    layoutPresets: [],
    dataSourceHealth: [],
  }
}

function renderControlUI(viewCount: number): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    render(<ControlUI connection={makeConnection(viewCount)} />, container!)
  })
  return container
}

function findPreviewBox(
  root: HTMLDivElement,
  streamId: string,
): Element | undefined {
  const label = [...root.querySelectorAll('.grid *')].find(
    (el) => el.children.length === 0 && el.textContent === streamId,
  )
  return label?.parentElement?.parentElement ?? undefined
}

// Grid preview boxes and controls used to be rendered without a `key`, so
// Preact matched them purely by position. When a cell earlier in the grid
// disappears, every later cell's position shifts down a slot and Preact
// grafts the surviving view's data onto the DOM node (and any transient
// state, like a hover) that belonged to a different view - see #39. Keying
// each box by its view's stable grid position fixes this.
describe('grid view identity across a shrinking view list', () => {
  test('a surviving preview box keeps its own DOM node after an earlier view disappears', () => {
    const root = renderControlUI(2)
    const boxBefore = findPreviewBox(root, 's1')
    expect(
      boxBefore,
      'expected to find a preview box for stream s1',
    ).not.toBeUndefined()

    act(() => {
      const connection = makeConnection(2)
      // Simulate the first cell's view disappearing (e.g. it's stream
      // stopped): only the second view remains, now at array position 0.
      connection.views = [connection.views[1]]
      connection.stateIdxMap = new Map([[1, connection.views[0]]])
      render(<ControlUI connection={connection} />, root)
    })

    const boxAfter = findPreviewBox(root, 's1')
    expect(
      boxAfter,
      'expected to still find a preview box for stream s1',
    ).not.toBeUndefined()
    expect(boxAfter).toBe(boxBefore)
  })
})
