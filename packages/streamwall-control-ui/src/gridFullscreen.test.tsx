import { act } from 'preact/test-utils'
import { asCellIdx, type ControlCommand } from 'streamwall-shared'
import { describe, expect, test, vi } from 'vitest'
import type { StreamwallConnection, ViewInfo } from './index.tsx'
import {
  makeConnection,
  makeStream,
  makeStreamWindowConfig,
  makeView,
  renderControlUI,
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

// Deliberately distinct from the grid cell index so tests that assert on
// dispatched commands prove they carry the stable view id, not the cell index
// (issue #397).
function makeFullscreenView(streamId: string, cells: number[]): ViewInfo {
  return makeView({
    id: 1000 + cells[0],
    contentUrl: `https://example.com/${streamId}`,
    cells,
  })
}

function baseConnection(
  overrides: Partial<StreamwallConnection> = {},
): StreamwallConnection {
  return makeConnection({
    sharedState: {
      views: { 0: { streamId: 's0' }, 1: { streamId: 's1' } },
    },
    config: makeStreamWindowConfig(),
    streams: [makeStream('s0'), makeStream('s1')],
    views: [makeFullscreenView('s0', [0]), makeFullscreenView('s1', [1])],
    delayState: undefined,
    ...overrides,
  })
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
        views: [makeFullscreenView('s1', [0, 1])],
        fullscreenViewIdx: asCellIdx(1),
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
        views: [makeFullscreenView('s1', [0, 1])],
        fullscreenViewIdx: asCellIdx(1),
      }),
    )

    const labels = [...root.querySelectorAll('.grid *')]
      .filter((el) => el.children.length === 0)
      .map((el) => el.textContent)

    expect(labels).toContain('s1')
    expect(labels).not.toContain('s0')
  })
})
