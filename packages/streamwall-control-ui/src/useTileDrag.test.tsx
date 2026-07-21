import { render } from 'preact'
import { act } from 'preact/test-utils'
import { asCellIdx, type StreamwallRole } from 'streamwall-shared'
import { afterEach, describe, expect, test, vi } from 'vitest'
import * as Y from 'yjs'
import { useTileDrag } from './useTileDrag.ts'

// react-hotkeys-hook resolves the real `react` package internally, which
// crashes under this package's preact/happy-dom test environment (unrelated
// to the drag/swap logic under test here) - stub it out and capture the
// escape handler so the cancel-on-escape behavior can still be exercised
// directly.
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

// 2x2 grid, each cell 100x100px, laid out at (0,0)-(200,200).
function stubGridRect(el: HTMLElement): void {
  el.getBoundingClientRect = () =>
    ({
      width: 200,
      height: 200,
      left: 0,
      top: 0,
      right: 200,
      bottom: 200,
      x: 0,
      y: 0,
      toJSON() {},
    }) as DOMRect
}

function Harness({
  doc,
  role = 'admin',
}: {
  doc: Y.Doc
  role?: StreamwallRole | null
}) {
  const stateIdxMap = new Map(
    [0, 1, 2, 3].map((idx) => [asCellIdx(idx), { spaces: [asCellIdx(idx)] }]),
  )
  const {
    hoveringIdx,
    swapStartIdx,
    moveStart,
    moveTargetIdx,
    updateHoveringIdx,
    clearHoveringIdx,
    handleSwapView,
    handleGridPointerDown,
  } = useTileDrag({ cols: 2, rows: 2, stateDoc: doc, stateIdxMap, role })

  return (
    <div
      data-testid="grid"
      onPointerMove={updateHoveringIdx}
      onPointerLeave={clearHoveringIdx}
      onPointerDown={handleGridPointerDown}
    >
      <div data-hovering={hoveringIdx ?? ''} />
      <div data-swap-start={swapStartIdx ?? ''} />
      <div data-move-start={moveStart?.idx ?? ''} />
      <div data-move-target={moveTargetIdx ?? ''} />
      <button type="button" onClick={() => handleSwapView(asCellIdx(0))}>
        start-swap-from-0
      </button>
    </div>
  )
}

function renderHarness(
  doc: Y.Doc,
  role: StreamwallRole | null = 'admin',
): {
  grid: HTMLDivElement
  hovering: () => string
  swapStart: () => string
  moveStartIdx: () => string
  moveTarget: () => string
} {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    render(<Harness doc={doc} role={role} />, container!)
  })
  const grid = container.querySelector('[data-testid="grid"]') as HTMLDivElement
  stubGridRect(grid)
  return {
    grid,
    hovering: () =>
      grid.querySelector('[data-hovering]')!.getAttribute('data-hovering')!,
    swapStart: () =>
      grid.querySelector('[data-swap-start]')!.getAttribute('data-swap-start')!,
    moveStartIdx: () =>
      grid.querySelector('[data-move-start]')!.getAttribute('data-move-start')!,
    moveTarget: () =>
      grid
        .querySelector('[data-move-target]')!
        .getAttribute('data-move-target')!,
  }
}

function pointerMoveAt(grid: HTMLDivElement, x: number, y: number): void {
  act(() => {
    grid.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        clientX: x,
        clientY: y,
      }),
    )
  })
}

function pointerDownAt(
  grid: HTMLDivElement,
  x: number,
  y: number,
  button = 0,
): void {
  act(() => {
    grid.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button,
        clientX: x,
        clientY: y,
      }),
    )
  })
}

function windowPointerUpAt(x: number, y: number): void {
  act(() => {
    window.dispatchEvent(
      new PointerEvent('pointerup', { clientX: x, clientY: y }),
    )
  })
}

describe('useTileDrag hovering', () => {
  test('reports the cell under the pointer', () => {
    const { grid, hovering } = renderHarness(new Y.Doc())

    pointerMoveAt(grid, 150, 50) // top-right cell (idx 1)

    expect(hovering()).toBe('1')
  })

  test('clears the hovered cell on pointer leave', () => {
    const { grid, hovering } = renderHarness(new Y.Doc())
    pointerMoveAt(grid, 150, 50)
    expect(hovering()).toBe('1')

    act(() => {
      grid.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }))
    })

    expect(hovering()).toBe('')
  })
})

describe('useTileDrag swap gesture', () => {
  test('starts a swap from a known cell', () => {
    const { grid, swapStart } = renderHarness(new Y.Doc())

    act(() => {
      const button = grid.querySelector('button')!
      button.click()
    })

    expect(swapStart()).toBe('0')
  })

  test('commits a swap into the shared doc when the target cell is clicked', () => {
    const doc = new Y.Doc()
    seedViews(
      doc,
      new Map([
        [0, 'stream-a'],
        [1, 'stream-b'],
      ]),
    )
    const { grid, swapStart } = renderHarness(doc)

    act(() => {
      grid.querySelector('button')!.click()
    })
    expect(swapStart()).toBe('0')

    pointerMoveAt(grid, 150, 50) // hover cell 1
    pointerDownAt(grid, 150, 50)

    expect(readViews(doc).get(0)).toBe('stream-b')
    expect(readViews(doc).get(1)).toBe('stream-a')
    expect(swapStart()).toBe('')
  })
})

describe('useTileDrag move gesture', () => {
  test('starts a drag-move from the hovered cell on pointerdown', () => {
    const { grid, moveStartIdx } = renderHarness(new Y.Doc())

    pointerMoveAt(grid, 50, 50) // cell 0
    pointerDownAt(grid, 50, 50)

    expect(moveStartIdx()).toBe('0')
  })

  test('tracks the hovered cell as the move target while dragging', () => {
    const { grid, moveTarget } = renderHarness(new Y.Doc())

    pointerMoveAt(grid, 50, 50)
    pointerDownAt(grid, 50, 50)
    pointerMoveAt(grid, 150, 150) // cell 3

    expect(moveTarget()).toBe('3')
  })

  test('commits a drag-move into the shared doc past the drag threshold', () => {
    const doc = new Y.Doc()
    seedViews(
      doc,
      new Map([
        [0, 'stream-a'],
        [3, 'stream-d'],
      ]),
    )
    const { grid, moveStartIdx } = renderHarness(doc)

    pointerMoveAt(grid, 50, 50) // cell 0
    pointerDownAt(grid, 50, 50)
    pointerMoveAt(grid, 150, 150) // cell 3
    windowPointerUpAt(150, 150)

    expect(readViews(doc).get(0)).toBe('stream-d')
    expect(readViews(doc).get(3)).toBe('stream-a')
    expect(moveStartIdx()).toBe('')
  })

  test('does not commit a move that never travels past the drag threshold', () => {
    const doc = new Y.Doc()
    seedViews(doc, new Map([[0, 'stream-a']]))
    const { grid, moveStartIdx } = renderHarness(doc)

    pointerMoveAt(grid, 50, 50)
    pointerDownAt(grid, 50, 50)
    windowPointerUpAt(51, 51) // 1.4px of travel, under the 5px threshold

    expect(readViews(doc).get(0)).toBe('stream-a')
    expect(moveStartIdx()).toBe('')
  })

  test('aborts an in-progress move on pointercancel without committing', () => {
    const doc = new Y.Doc()
    seedViews(
      doc,
      new Map([
        [0, 'stream-a'],
        [3, 'stream-d'],
      ]),
    )
    const { grid, moveStartIdx } = renderHarness(doc)

    pointerMoveAt(grid, 50, 50)
    pointerDownAt(grid, 50, 50)
    pointerMoveAt(grid, 150, 150)
    act(() => {
      window.dispatchEvent(new PointerEvent('pointercancel'))
    })

    expect(readViews(doc).get(0)).toBe('stream-a')
    expect(readViews(doc).get(3)).toBe('stream-d')
    expect(moveStartIdx()).toBe('')
  })

  test('escape cancels an in-progress move without committing', () => {
    const doc = new Y.Doc()
    seedViews(
      doc,
      new Map([
        [0, 'stream-a'],
        [3, 'stream-d'],
      ]),
    )
    const { grid, moveStartIdx } = renderHarness(doc)

    pointerMoveAt(grid, 50, 50)
    pointerDownAt(grid, 50, 50)
    pointerMoveAt(grid, 150, 150)
    act(() => {
      escapeHandler?.()
    })
    windowPointerUpAt(150, 150)

    expect(readViews(doc).get(0)).toBe('stream-a')
    expect(readViews(doc).get(3)).toBe('stream-d')
    expect(moveStartIdx()).toBe('')
  })
})

describe('useTileDrag role gating', () => {
  test('a monitor role cannot commit a swap', () => {
    const doc = new Y.Doc()
    seedViews(
      doc,
      new Map([
        [0, 'stream-a'],
        [1, 'stream-b'],
      ]),
    )
    const { grid } = renderHarness(doc, 'monitor')

    act(() => {
      grid.querySelector('button')!.click()
    })
    pointerMoveAt(grid, 150, 50)
    pointerDownAt(grid, 150, 50)

    expect(readViews(doc).get(0)).toBe('stream-a')
    expect(readViews(doc).get(1)).toBe('stream-b')
  })

  test('a monitor role cannot start a drag-move', () => {
    const doc = new Y.Doc()
    seedViews(
      doc,
      new Map([
        [0, 'stream-a'],
        [3, 'stream-d'],
      ]),
    )
    const { grid, moveStartIdx } = renderHarness(doc, 'monitor')

    pointerMoveAt(grid, 50, 50)
    pointerDownAt(grid, 50, 50)
    pointerMoveAt(grid, 150, 150)
    windowPointerUpAt(150, 150)

    expect(moveStartIdx()).toBe('')
    expect(readViews(doc).get(0)).toBe('stream-a')
    expect(readViews(doc).get(3)).toBe('stream-d')
  })
})
