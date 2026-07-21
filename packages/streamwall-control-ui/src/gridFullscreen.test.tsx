import { render } from 'preact'
import { act } from 'preact/test-utils'
import type {
  ControlCommand,
  StreamData,
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

function makeView(streamId: string, spaces: number[]): ViewInfo {
  return {
    state: {
      state: {
        displaying: {
          running: {
            playback: 'playing',
            video: 'normal',
            audio: 'muted',
            pause: 'unpaused',
            swap: 'idle',
          },
        },
      },
      context: {
        // Deliberately distinct from the grid cell index so tests that assert
        // on dispatched commands prove they carry the stable view id, not the
        // cell index (issue #397).
        id: 1000 + spaces[0],
        content: { url: `https://example.com/${streamId}`, kind: 'video' },
        info: null,
        pos: {
          x: spaces[0] * 100,
          y: 0,
          width: 100 * spaces.length,
          height: 100,
          spaces,
        },
        error: null,
        volume: 1,
      },
    },
    isListening: false,
    isBackgroundListening: false,
    isBlurred: false,
    isPaused: false,
    volume: 1,
    spaces,
  }
}

function baseConnection(
  overrides: Partial<StreamwallConnection> = {},
): StreamwallConnection {
  const config: StreamWindowConfig = {
    cols: 2,
    rows: 1,
    width: 200,
    height: 100,
    frameless: false,
    fullscreen: false,
    activeColor: '#0f0',
    backgroundColor: '#000',
  }
  const streams = [makeStream('s0'), makeStream('s1')]
  return {
    isConnected: true,
    role: 'operator',
    send: () => {},
    sharedState: {
      views: { 0: { streamId: 's0' }, 1: { streamId: 's1' } },
    },
    stateDoc: new Y.Doc(),
    config,
    streams,
    customStreams: [],
    views: [makeView('s0', [0]), makeView('s1', [1])],
    fullscreenViewIdx: null,
    stateIdxMap: new Map(),
    delayState: undefined,
    authState: undefined,
    layoutPresets: [],
    favorites: [],
    dataSourceHealth: [],
    ...overrides,
  }
}

function renderControlUI(connection: StreamwallConnection): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    render(<ControlUI connection={connection} />, container!)
  })
  return container
}

// The GridControls container (the interactive layer that owns the double-click
// handler) is tagged by its box-anchor cell index.
function gridControls(root: HTMLDivElement, anchorIdx: number): HTMLElement {
  const match = root.querySelector<HTMLElement>(
    `[data-testid="grid-controls"][data-idx="${anchorIdx}"]`,
  )
  if (!match) {
    throw new Error(`no GridControls found for anchor ${anchorIdx}`)
  }
  return match
}

describe('ControlUI double-click fullscreen', () => {
  test('double-clicking a tile requests expanding that view to fullscreen', () => {
    const sent: ControlCommand[] = []
    const root = renderControlUI(
      baseConnection({ send: (msg) => sent.push(msg) }),
    )

    const controls = gridControls(root, 1)
    act(() => {
      controls.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })

    expect(sent).toContainEqual({
      type: 'set-view-fullscreen',
      viewId: 1001,
      fullscreen: true,
    })
  })

  test('double-clicking while a view is already expanded requests collapse', () => {
    const sent: ControlCommand[] = []
    // One spanning view for the already-expanded stream s1.
    const root = renderControlUI(
      baseConnection({
        send: (msg) => sent.push(msg),
        views: [makeView('s1', [0, 1])],
        fullscreenViewIdx: 1,
      }),
    )

    // The single spanning view is anchored at cell 0.
    const controls = gridControls(root, 0)
    act(() => {
      controls.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })

    expect(sent).toContainEqual({
      type: 'set-view-fullscreen',
      viewId: 1000,
      fullscreen: false,
    })
  })

  test('renders the expanded stream, not the cell-0 assignment, while fullscreen', () => {
    // s1 (originally at cell 1) is expanded to span the whole 2-cell wall.
    // Its stream is only recorded at cell 1 in the persisted assignments, so
    // the preview must resolve via fullscreenViewIdx rather than spaces[0].
    const root = renderControlUI(
      baseConnection({
        views: [makeView('s1', [0, 1])],
        fullscreenViewIdx: 1,
      }),
    )

    const labels = [...root.querySelectorAll('.grid *')]
      .filter((el) => el.children.length === 0)
      .map((el) => el.textContent)

    expect(labels).toContain('s1')
    expect(labels).not.toContain('s0')
  })
})
