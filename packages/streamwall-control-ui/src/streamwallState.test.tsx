import { render } from 'preact'
import { act } from 'preact/test-utils'
import type { StreamwallState, ViewState } from 'streamwall-shared'
import { afterEach, describe, expect, test } from 'vitest'
import { useStreamwallState } from './streamwallState.tsx'

let container: HTMLDivElement | undefined

afterEach(() => {
  if (container) {
    act(() => render(null, container!))
    container.remove()
    container = undefined
  }
})

function makeViewState(
  pause: 'paused' | 'unpaused',
  overrides: Partial<ViewState['context']> = {},
): ViewState {
  return {
    state: {
      displaying: {
        running: {
          playback: 'playing',
          video: 'normal',
          audio: 'muted',
          pause,
          swap: 'idle',
        },
      },
    },
    context: {
      id: 1,
      content: null,
      info: null,
      pos: { x: 0, y: 0, width: 100, height: 100, spaces: [0] },
      error: null,
      volume: 1,
      ...overrides,
    },
  }
}

function makeState(views: ViewState[]): StreamwallState {
  return {
    identity: { role: 'admin' },
    config: {
      cols: 1,
      rows: 1,
      width: 100,
      height: 100,
      frameless: false,
      fullscreen: false,
      activeColor: '#fff',
      backgroundColor: '#000',
    },
    streams: [],
    customStreams: [],
    views,
    fullscreenViewIdx: null,
    streamdelay: null,
    layoutPresets: [],
    favorites: [],
    dataSourceHealth: [],
  }
}

function renderState(state: StreamwallState) {
  let result: ReturnType<typeof useStreamwallState> | undefined
  function Probe() {
    result = useStreamwallState(state)
    return null
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    render(<Probe />, container!)
  })
  return result!
}

describe('useStreamwallState', () => {
  test('derives isPaused for a view whose media playback is paused', () => {
    const { views, stateIdxMap } = renderState(
      makeState([makeViewState('paused')]),
    )

    expect(views[0]!.isPaused).toBe(true)
    expect(stateIdxMap.get(0)!.isPaused).toBe(true)
  })

  test('leaves isPaused false while the view keeps playing', () => {
    const { views } = renderState(makeState([makeViewState('unpaused')]))

    expect(views[0]!.isPaused).toBe(false)
  })
})
