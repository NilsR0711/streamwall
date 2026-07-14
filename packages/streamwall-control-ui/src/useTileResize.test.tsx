import { render } from 'preact'
import { useState } from 'preact/hooks'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'
import * as Y from 'yjs'
import { useTileResize } from './useTileResize.ts'

// react-hotkeys-hook resolves the real `react` package internally, which
// crashes under this package's preact/happy-dom test environment (unrelated
// to the resize logic under test here) - stub it out and capture the escape
// handler so the cancel-on-escape behavior can still be exercised directly.
let escapeHandler: (() => void) | undefined
vi.mock('react-hotkeys-hook', () => ({
  useHotkeys: (
    keys: string,
    handler: () => void,
    _options?: unknown,
    _deps?: unknown[],
  ) => {
    if (keys === 'escape') {
      escapeHandler = handler
    }
  },
}))

let container: HTMLDivElement | undefined

afterEach(() => {
  if (container) {
    act(() => render(null, container!))
    container.remove()
    container = undefined
  }
})

function seedViews(
  doc: Y.Doc,
  assignments: Map<number, string | undefined>,
): void {
  const views = doc.getMap<Y.Map<string | undefined>>('views')
  doc.transact(() => {
    for (const [idx, streamId] of assignments) {
      const cell = new Y.Map<string | undefined>()
      cell.set('streamId', streamId)
      views.set(String(idx), cell)
    }
  })
}

function readViews(doc: Y.Doc): Map<number, string | undefined> {
  const views = doc.getMap<Y.Map<string | undefined>>('views')
  const result = new Map<number, string | undefined>()
  for (const [key, cell] of views) {
    result.set(Number(key), cell.get('streamId'))
  }
  return result
}

function fakePointerDown(button = 0): PointerEvent {
  return {
    button,
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as PointerEvent
}

function fakeKeyDown(key: string): KeyboardEvent {
  return { key, preventDefault: () => {} } as unknown as KeyboardEvent
}

// 2-column grid. sharedState views mirror the doc's seeded assignments.
function Harness({
  doc,
  sharedState,
}: {
  doc: Y.Doc
  sharedState: { views: { [idx: string]: { streamId: string | undefined } } }
}) {
  const [hoveringIdx, setHoveringIdx] = useState<number | undefined>()
  const { resize, handleResizeStart, handleResizeKeyDown } = useTileResize({
    cols: 2,
    rows: 2,
    hoveringIdx,
    stateDoc: doc,
    sharedState,
  })

  return (
    <div>
      <div data-resizing={resize?.anchorIdx ?? ''} />
      <button
        type="button"
        onClick={() => handleResizeStart(0, 'e', [0], fakePointerDown())}
      >
        start-resize-anchor-0-e
      </button>
      <button type="button" onClick={() => setHoveringIdx(1)}>
        hover-1
      </button>
      <button
        type="button"
        onClick={() =>
          handleResizeKeyDown(0, 'e', [0], fakeKeyDown('ArrowRight'))
        }
      >
        keyboard-resize-anchor-0-e-right
      </button>
      <button
        type="button"
        onClick={() =>
          handleResizeKeyDown(0, 'e', [0], fakeKeyDown('ArrowDown'))
        }
      >
        keyboard-resize-anchor-0-e-down
      </button>
    </div>
  )
}

function renderHarness(
  doc: Y.Doc,
  sharedState: { views: { [idx: string]: { streamId: string | undefined } } },
): {
  click: (label: string) => void
  resizing: () => string
} {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    render(<Harness doc={doc} sharedState={sharedState} />, container!)
  })
  const buttons = () =>
    Array.from(container!.querySelectorAll('button')) as HTMLButtonElement[]
  return {
    click: (label: string) => {
      act(() => {
        buttons()
          .find((b) => b.textContent === label)!
          .click()
      })
    },
    resizing: () =>
      container!
        .querySelector('[data-resizing]')!
        .getAttribute('data-resizing')!,
  }
}

function windowPointerUp(): void {
  act(() => {
    window.dispatchEvent(new PointerEvent('pointerup'))
  })
}

describe('useTileResize', () => {
  test('starts a resize from the anchor cell when it has a stream assigned', () => {
    const doc = new Y.Doc()
    seedViews(doc, new Map([[0, 'stream-a']]))
    const { click, resizing } = renderHarness(doc, {
      views: { '0': { streamId: 'stream-a' } },
    })

    click('start-resize-anchor-0-e')

    expect(resizing()).toBe('0')
  })

  test('does not start a resize from a cell with no stream assigned', () => {
    const doc = new Y.Doc()
    const { click, resizing } = renderHarness(doc, {
      views: { '0': { streamId: undefined } },
    })

    click('start-resize-anchor-0-e')

    expect(resizing()).toBe('')
  })

  test('commits the resized box into the shared doc on pointerup', () => {
    const doc = new Y.Doc()
    // Cell 1 starts out unassigned but present, matching how a real grid's
    // cells are all pre-populated with an (initially empty) Y.Map.
    seedViews(
      doc,
      new Map([
        [0, 'stream-a'],
        [1, undefined],
      ]),
    )
    const { click, resizing } = renderHarness(doc, {
      views: { '0': { streamId: 'stream-a' } },
    })

    click('start-resize-anchor-0-e')
    click('hover-1')
    windowPointerUp()

    // Resizing 'e' (east) from anchor 0 out to cell 1 spans both top cells.
    expect(readViews(doc).get(0)).toBe('stream-a')
    expect(readViews(doc).get(1)).toBe('stream-a')
    expect(resizing()).toBe('')
  })

  test('aborts an in-progress resize on pointercancel without committing', () => {
    const doc = new Y.Doc()
    seedViews(doc, new Map([[0, 'stream-a']]))
    const { click, resizing } = renderHarness(doc, {
      views: { '0': { streamId: 'stream-a' } },
    })

    click('start-resize-anchor-0-e')
    click('hover-1')
    act(() => {
      window.dispatchEvent(new PointerEvent('pointercancel'))
    })

    expect(readViews(doc).get(1)).toBeUndefined()
    expect(resizing()).toBe('')
  })

  test('escape cancels an in-progress resize without committing', () => {
    const doc = new Y.Doc()
    seedViews(doc, new Map([[0, 'stream-a']]))
    const { click, resizing } = renderHarness(doc, {
      views: { '0': { streamId: 'stream-a' } },
    })

    click('start-resize-anchor-0-e')
    click('hover-1')
    act(() => {
      escapeHandler?.()
    })
    windowPointerUp()

    expect(readViews(doc).get(1)).toBeUndefined()
    expect(resizing()).toBe('')
  })
})

describe('useTileResize keyboard resize', () => {
  test('commits a one-cell step immediately on arrow key, without an in-progress gesture', () => {
    const doc = new Y.Doc()
    seedViews(
      doc,
      new Map([
        [0, 'stream-a'],
        [1, undefined],
      ]),
    )
    const { click, resizing } = renderHarness(doc, {
      views: { '0': { streamId: 'stream-a' } },
    })

    click('keyboard-resize-anchor-0-e-right')

    expect(readViews(doc).get(0)).toBe('stream-a')
    expect(readViews(doc).get(1)).toBe('stream-a')
    // Unlike a pointer resize, there's no hover preview to commit later.
    expect(resizing()).toBe('')
  })

  test("ignores an arrow key on the handle's locked cross-axis", () => {
    const doc = new Y.Doc()
    seedViews(
      doc,
      new Map([
        [0, 'stream-a'],
        [2, undefined],
      ]),
    )
    const { click } = renderHarness(doc, {
      views: { '0': { streamId: 'stream-a' } },
    })

    // The 'e' (east) handle only drags width; ArrowDown is its locked axis.
    click('keyboard-resize-anchor-0-e-down')

    expect(readViews(doc).get(2)).toBeUndefined()
  })

  test('does not resize a cell with no stream assigned', () => {
    const doc = new Y.Doc()
    seedViews(doc, new Map([[1, undefined]]))
    const { click } = renderHarness(doc, {
      views: { '0': { streamId: undefined } },
    })

    click('keyboard-resize-anchor-0-e-right')

    expect(readViews(doc).get(1)).toBeUndefined()
  })
})
