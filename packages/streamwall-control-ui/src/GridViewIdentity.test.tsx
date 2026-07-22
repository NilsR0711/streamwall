import { asCellIdx, type CellIdx } from 'streamwall-shared'
import { describe, expect, test, vi } from 'vitest'
import type { StreamwallConnection, ViewInfo } from './index.tsx'
import {
  makeConnection,
  makeStream,
  makeStreamWindowConfig,
  makeView,
  renderControlUI,
  rerenderControlUI,
} from './testHelpers.tsx'

vi.mock(
  'react-icons/fa',
  async () => (await import('./testIconStubs.tsx')).faIconStubs,
)
vi.mock(
  'react-icons/md',
  async () => (await import('./testIconStubs.tsx')).mdIconStubs,
)
vi.mock('react-hotkeys-hook', () => ({
  useHotkeys: () => {},
}))

function makeGridConnection(viewCount: number): StreamwallConnection {
  const streams = Array.from({ length: viewCount }, (_, i) =>
    makeStream(`s${i}`),
  )
  const views = Array.from({ length: viewCount }, (_, i) =>
    makeView({ id: i, contentUrl: `https://example.com/s${i}`, cells: [i] }),
  )
  const stateIdxMap = new Map<CellIdx, ViewInfo>()
  views.forEach((v, i) => stateIdxMap.set(asCellIdx(i), v))

  return makeConnection({
    sharedState: {
      views: Object.fromEntries(
        streams.map((s, i) => [i, { streamId: s._id }]),
      ),
    },
    config: makeStreamWindowConfig({
      cols: viewCount,
      width: 100 * viewCount,
    }),
    streams,
    views,
    stateIdxMap,
  })
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
    const root = renderControlUI(makeGridConnection(2))
    const boxBefore = findPreviewBox(root, 's1')
    expect(
      boxBefore,
      'expected to find a preview box for stream s1',
    ).not.toBeUndefined()

    const connection = makeGridConnection(2)
    // Simulate the first cell's view disappearing (e.g. it's stream
    // stopped): only the second view remains, now at array position 0.
    connection.views = [connection.views[1]]
    connection.stateIdxMap = new Map([[asCellIdx(1), connection.views[0]]])
    rerenderControlUI(root, connection)

    const boxAfter = findPreviewBox(root, 's1')
    expect(
      boxAfter,
      'expected to still find a preview box for stream s1',
    ).not.toBeUndefined()
    expect(boxAfter).toBe(boxBefore)
  })
})
