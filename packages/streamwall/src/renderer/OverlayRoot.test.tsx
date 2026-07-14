// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import type {
  StreamData,
  StreamWindowConfig,
  ViewState,
} from 'streamwall-shared'
import { afterEach, describe, expect, test } from 'vitest'
import { Overlay } from './OverlayRoot'

let container: HTMLDivElement | undefined

afterEach(() => {
  if (container) {
    act(() => render(null, container!))
    container.remove()
    container = undefined
  }
})

function makeConfig(cols: number): StreamWindowConfig {
  return {
    cols,
    rows: 1,
    width: 100 * cols,
    height: 100,
    frameless: false,
    fullscreen: false,
    activeColor: '#0f0',
    backgroundColor: '#000',
  }
}

function makeView(idx: number, label: string): ViewState {
  return {
    state: {
      displaying: {
        running: { playback: 'playing', video: 'normal', audio: 'muted' },
      },
    },
    context: {
      id: idx,
      content: { url: `https://example.com/${label}`, kind: 'video' },
      info: null,
      pos: { x: idx * 100, y: 0, width: 100, height: 100, spaces: [idx] },
      error: null,
      volume: 1,
    },
  }
}

function makeStream(label: string): StreamData {
  return {
    _id: label,
    _dataSource: 'test',
    kind: 'video',
    link: `https://example.com/${label}`,
    label,
  }
}

function renderOverlay(
  views: ViewState[],
  streams: StreamData[],
): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    render(
      <Overlay
        config={makeConfig(views.length)}
        views={views}
        streams={streams}
      />,
      container!,
    )
  })
  return container
}

// Walks up from the matched label span to the tile element that is a direct
// child of the overlay container (i.e. the `SpaceBorder` for that view),
// rather than stopping at the shared container itself.
function findTile(root: HTMLDivElement, label: string): Element | undefined {
  const overlayContainer = root.firstElementChild
  const span = [...root.querySelectorAll('span')].find(
    (el) => el.textContent === label,
  )
  let node: Element | null = span ?? null
  while (node && node.parentElement !== overlayContainer) {
    node = node.parentElement
  }
  return node ?? undefined
}

// Each active view's border/tile used to be rendered without a `key`, so
// Preact matched them purely by position. When an earlier view disappears,
// every later view's position shifts down a slot and Preact grafts the
// surviving view's content onto the wrong DOM node - see #39. Keying each
// tile by its stable grid position fixes this.
describe('overlay view identity across a shrinking view list', () => {
  test('a surviving tile keeps its own DOM node after an earlier view disappears', () => {
    const streams = [makeStream('view-0'), makeStream('view-1')]
    const root = renderOverlay(
      [makeView(0, 'view-0'), makeView(1, 'view-1')],
      streams,
    )
    const tileBefore = findTile(root, 'view-1')
    expect(tileBefore, 'expected to find a tile for view-1').not.toBeUndefined()

    act(() => {
      render(
        <Overlay
          config={makeConfig(1)}
          views={[makeView(1, 'view-1')]}
          streams={streams}
        />,
        root,
      )
    })

    const tileAfter = findTile(root, 'view-1')
    expect(
      tileAfter,
      'expected to still find a tile for view-1',
    ).not.toBeUndefined()
    expect(tileAfter).toBe(tileBefore)
  })
})
