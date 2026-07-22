import { render } from 'preact'
import { act } from 'preact/test-utils'
import {
  asCellIdx,
  asViewId,
  type StreamData,
  type StreamDelayStatus,
  type StreamWindowConfig,
} from 'streamwall-shared'
import { afterEach } from 'vitest'
import * as Y from 'yjs'
import {
  ControlUI,
  type StreamwallConnection,
  type ViewInfo,
} from './index.tsx'

export function makeDelayState(): StreamDelayStatus {
  return {
    isConnected: true,
    delaySeconds: 0,
    restartSeconds: 0,
    isCensored: false,
    isStreamRunning: true,
    startTime: 0,
    state: 'idle',
  }
}

export function makeStream(id: string): StreamData {
  return {
    _id: id,
    _dataSource: 'test',
    kind: 'video',
    link: `https://example.com/${id}`,
  }
}

export function makeStreamWindowConfig(
  overrides: Partial<StreamWindowConfig> = {},
): StreamWindowConfig {
  return {
    cols: 2,
    rows: 1,
    width: 200,
    height: 100,
    frameless: false,
    fullscreen: false,
    activeColor: '#0f0',
    backgroundColor: '#000',
    ...overrides,
  }
}

export interface MakeViewOptions {
  /** The stable view id carried on `context.id` (issue #397). */
  id: number
  /** The URL rendered as the view's content. */
  contentUrl: string
  /** The grid cells the view occupies. */
  cells: number[]
}

export function makeView({ id, contentUrl, cells }: MakeViewOptions): ViewInfo {
  const spaces = cells.map(asCellIdx)
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
        id: asViewId(id),
        content: { url: contentUrl, kind: 'video' },
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

export function makeConnection(
  overrides: Partial<StreamwallConnection> = {},
): StreamwallConnection {
  return {
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
    delayState: makeDelayState(),
    authState: undefined,
    layoutPresets: [],
    favorites: [],
    dataSourceHealth: [],
    ...overrides,
  }
}

const containers: HTMLDivElement[] = []

// Importing this module registers the teardown on the importing spec file's
// root suite, so every mounted ControlUI is unmounted and detached again.
// Tracked as an array (not a single slot) because a test that calls
// `renderControlUI` more than once must not leak the earlier containers and
// their Preact roots - every mount collected here gets unmounted.
afterEach(() => {
  for (const container of containers.splice(0)) {
    act(() => render(null, container))
    container.remove()
  }
})

/** Mounts a fresh ControlUI into a detachable container and returns its root. */
export function renderControlUI(
  connection: StreamwallConnection,
): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  containers.push(container)
  act(() => {
    render(<ControlUI connection={connection} />, container)
  })
  return container
}

/** Re-renders ControlUI into an already mounted root, keeping the same tree. */
export function rerenderControlUI(
  root: HTMLDivElement,
  connection: StreamwallConnection,
): void {
  act(() => {
    render(<ControlUI connection={connection} />, root)
  })
}
