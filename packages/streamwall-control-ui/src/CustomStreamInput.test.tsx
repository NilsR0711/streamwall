import { render } from 'preact'
import { act } from 'preact/test-utils'
import type { StreamData, StreamDelayStatus } from 'streamwall-shared'
import { afterEach, describe, expect, test, vi } from 'vitest'
import * as Y from 'yjs'
import { ControlUI, type StreamwallConnection } from './index.tsx'

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

function makeCustomStream(link: string, label: string): StreamData {
  return {
    _id: link,
    _dataSource: 'custom',
    kind: 'video',
    link,
    label,
  }
}

function makeConnection(customStreams: StreamData[]): StreamwallConnection {
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
    streams: [],
    customStreams,
    views: [],
    stateIdxMap: new Map(),
    delayState,
    authState: undefined,
    layoutPresets: [],
    dataSourceHealth: [],
  }
}

function renderControlUI(customStreams: StreamData[]): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    render(<ControlUI connection={makeConnection(customStreams)} />, container!)
  })
  return container
}

function labelInputs(root: HTMLDivElement): HTMLInputElement[] {
  return [
    ...root.querySelectorAll<HTMLInputElement>(
      'input[placeholder="Label (optional)"]',
    ),
  ]
}

// Custom streams used to be keyed by their array index. Deleting an earlier
// entry shifts every later entry's index down a slot, so Preact matched the
// surviving stream's props onto the DOM node (and any in-progress edit) that
// belonged to the deleted entry instead - see #39. Keying by the stream's
// (stable, unique) `link` fixes this.
describe('custom stream input identity across deletion', () => {
  test("a surviving custom stream's input keeps its own DOM node after an earlier entry is removed", () => {
    const root = renderControlUI([
      makeCustomStream('https://a.example', 'A'),
      makeCustomStream('https://b.example', 'B'),
    ])

    const [inputA, inputB] = labelInputs(root)
    expect(inputA.value).toBe('A')
    expect(inputB.value).toBe('B')

    act(() => {
      render(
        <ControlUI
          connection={makeConnection([
            makeCustomStream('https://b.example', 'B'),
          ])}
        />,
        root,
      )
    })

    const [survivingInput] = labelInputs(root)
    expect(survivingInput.value).toBe('B')
    expect(survivingInput).toBe(inputB)
  })
})
