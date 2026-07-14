import { render } from 'preact'
import { act } from 'preact/test-utils'
import type {
  StreamData,
  StreamDelayStatus,
  StreamWindowConfig,
  StreamwallRole,
} from 'streamwall-shared'
import { afterEach, describe, expect, test, vi } from 'vitest'
import * as Y from 'yjs'
import {
  ControlUI,
  type StreamwallConnection,
  type ViewInfo,
} from './index.tsx'

// react-icons renders through preact/compat's Context.Consumer, which
// currently crashes under this package's happy-dom test environment
// (unrelated to the drag-move gating under test here) - stub the icons out
// so ControlUI's own rendering can be exercised in isolation.
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

function makeStream(id: string, label: string): StreamData {
  return {
    _id: id,
    _dataSource: 'custom',
    kind: 'video',
    link: `https://example.com/${id}`,
    label,
  }
}

function renderControlUI(role: StreamwallRole | null): {
  root: HTMLDivElement
  stateDoc: Y.Doc
} {
  container = document.createElement('div')
  document.body.appendChild(container)

  const stateDoc = new Y.Doc()
  stateDoc.transact(() => {
    const viewsMap = stateDoc.getMap<Y.Map<string | undefined>>('views')
    const box0 = new Y.Map<string | undefined>()
    box0.set('streamId', 'stream-a')
    viewsMap.set('0', box0)
    const box1 = new Y.Map<string | undefined>()
    box1.set('streamId', 'stream-b')
    viewsMap.set('1', box1)
  })

  const delayState: StreamDelayStatus = {
    isConnected: true,
    delaySeconds: 0,
    restartSeconds: 0,
    isCensored: false,
    isStreamRunning: true,
    startTime: 0,
    state: 'idle',
  }

  const stateIdxMap = new Map<number, ViewInfo>([
    [0, { spaces: [0] } as ViewInfo],
    [1, { spaces: [1] } as ViewInfo],
  ])

  const connection: StreamwallConnection = {
    isConnected: true,
    role,
    send: () => {},
    sharedState: {
      views: {
        '0': { streamId: 'stream-a' },
        '1': { streamId: 'stream-b' },
      },
    },
    stateDoc,
    config,
    streams: [
      makeStream('stream-a', 'Stream A'),
      makeStream('stream-b', 'Stream B'),
    ],
    customStreams: [],
    views: [],
    stateIdxMap,
    delayState,
    authState: undefined,
    layoutPresets: [],
    dataSourceHealth: [],
  }

  act(() => {
    render(<ControlUI connection={connection} />, container!)
  })
  return { root: container, stateDoc }
}

function getStreamId(stateDoc: Y.Doc, idx: number): string | undefined {
  return stateDoc
    .getMap<Y.Map<string | undefined>>('views')
    .get(String(idx))
    ?.get('streamId')
}

// Drags cell 0 onto cell 1. happy-dom doesn't compute real layout geometry, so
// `getBoundingClientRect` is stubbed to a fixed 800x400 box matching `config`
// above, making `computeHoveringIdx`'s cell math deterministic (cell 0 spans
// x:[0,400), cell 1 spans x:[400,800)).
function dragCell0OntoCell1(root: HTMLDivElement) {
  const grid = root.querySelector('.grid') as HTMLElement
  grid.getBoundingClientRect = () =>
    ({
      width: 800,
      height: 400,
      left: 0,
      top: 0,
      right: 800,
      bottom: 400,
      x: 0,
      y: 0,
      toJSON() {},
    }) as DOMRect

  const cell0Input = grid.querySelectorAll('input')[0]

  act(() => {
    grid.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        clientX: 100,
        clientY: 100,
      }),
    )
  })
  act(() => {
    cell0Input.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        pointerId: 1,
        clientX: 100,
        clientY: 100,
      }),
    )
  })
  act(() => {
    grid.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        clientX: 500,
        clientY: 100,
      }),
    )
  })
  act(() => {
    window.dispatchEvent(
      new PointerEvent('pointerup', { clientX: 500, clientY: 100 }),
    )
  })
}

// Locks in the fix for issue #286: the drag-move gesture (`handleGridPointerDown`
// / `swapBoxes`) had no `roleCan(role, 'mutate-state-doc')` gate, unlike
// `GridInput`'s own `disabled` attribute. A `monitor`-role client could start a
// drag-move gesture, see it apply to their own local Y.Doc, then watch it
// silently roll back once the control-server rejected the update server-side.
describe('grid drag-move role gating', () => {
  test('commits a drag-move swap for a role that can mutate the state doc', () => {
    const { root, stateDoc } = renderControlUI('operator')

    dragCell0OntoCell1(root)

    expect(getStreamId(stateDoc, 0)).toBe('stream-b')
    expect(getStreamId(stateDoc, 1)).toBe('stream-a')
  })

  test('does not mutate the state doc when dragged by a monitor role', () => {
    const { root, stateDoc } = renderControlUI('monitor')

    dragCell0OntoCell1(root)

    expect(getStreamId(stateDoc, 0)).toBe('stream-a')
    expect(getStreamId(stateDoc, 1)).toBe('stream-b')
  })
})
