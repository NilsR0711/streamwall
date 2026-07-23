import { render } from 'preact'
import { act } from 'preact/test-utils'
import { asCellIdx } from 'streamwall-shared'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ResizeHandles } from './ResizeHandles.tsx'

let container: HTMLDivElement | undefined

afterEach(() => {
  if (container) {
    act(() => render(null, container!))
    container.remove()
    container = undefined
  }
})

function renderHandles(
  props: Partial<Parameters<typeof ResizeHandles>[0]> = {},
): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    render(
      <ResizeHandles
        anchorIdx={asCellIdx(0)}
        originalSpaces={[asCellIdx(0)]}
        tileLabel="Downtown cam"
        role="operator"
        onResizeStart={() => {}}
        onResizeKeyDown={() => {}}
        {...props}
      />,
      container!,
    )
  })
  return container
}

describe('ResizeHandles role gating', () => {
  test('enables the resize handles for a role that can mutate the state doc', () => {
    const box = renderHandles({ role: 'operator' })

    const buttons = box.querySelectorAll('button')
    expect(buttons.length).toBeGreaterThan(0)
    for (const button of buttons) {
      expect((button as HTMLButtonElement).disabled).toBe(false)
    }
  })

  test('disables the resize handles for a monitor role', () => {
    const box = renderHandles({ role: 'monitor' })

    const buttons = box.querySelectorAll('button')
    expect(buttons.length).toBeGreaterThan(0)
    for (const button of buttons) {
      expect((button as HTMLButtonElement).disabled).toBe(true)
    }
  })

  test('does not invoke onResizeStart/onResizeKeyDown when disabled for a monitor role', () => {
    const onResizeStart = vi.fn()
    const onResizeKeyDown = vi.fn()
    const box = renderHandles({
      role: 'monitor',
      onResizeStart,
      onResizeKeyDown,
    })
    const handle = box.querySelector('button.handle.e') as HTMLButtonElement

    handle.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }),
    )
    handle.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }),
    )

    expect(onResizeStart).not.toHaveBeenCalled()
    expect(onResizeKeyDown).not.toHaveBeenCalled()
  })

  test('invokes onResizeStart/onResizeKeyDown when enabled for an operator role', () => {
    const onResizeStart = vi.fn()
    const onResizeKeyDown = vi.fn()
    const box = renderHandles({
      role: 'operator',
      onResizeStart,
      onResizeKeyDown,
    })
    const handle = box.querySelector('button.handle.e') as HTMLButtonElement

    handle.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }),
    )
    handle.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }),
    )

    expect(onResizeStart).toHaveBeenCalledWith(0, 'e', [0], expect.anything())
    expect(onResizeKeyDown).toHaveBeenCalledWith(0, 'e', [0], expect.anything())
  })

  test('folds the tile label into every resize handle aria-label', () => {
    const box = renderHandles({ tileLabel: 'Downtown cam' })

    expect(
      box.querySelector(
        'button[aria-label="Resize right edge of Downtown cam"]',
      ),
    ).not.toBeNull()
    expect(
      box.querySelector(
        'button[aria-label="Resize bottom edge of Downtown cam"]',
      ),
    ).not.toBeNull()
    expect(
      box.querySelector(
        'button[aria-label="Resize bottom-right corner of Downtown cam"]',
      ),
    ).not.toBeNull()
  })

  test('gives handles on different tiles distinct aria-labels', () => {
    const first = renderHandles({
      anchorIdx: asCellIdx(0),
      tileLabel: 'Downtown cam',
    })
    const firstLabel = first
      .querySelector('button.handle.e')
      ?.getAttribute('aria-label')
    // Tear down the first render before mounting the second so their ids and
    // labels don't coexist in the same document.
    act(() => render(null, first))
    first.remove()
    container = undefined

    const second = renderHandles({
      anchorIdx: asCellIdx(3),
      tileLabel: 'Harbor cam',
    })
    const secondLabel = second
      .querySelector('button.handle.e')
      ?.getAttribute('aria-label')

    expect(firstLabel).toBe('Resize right edge of Downtown cam')
    expect(secondLabel).toBe('Resize right edge of Harbor cam')
    expect(firstLabel).not.toBe(secondLabel)
  })

  test('exposes the keyboard-override hint via aria-describedby', () => {
    const box = renderHandles({ anchorIdx: asCellIdx(2) })

    const handle = box.querySelector('button.handle.e') as HTMLButtonElement
    const hintId = handle.getAttribute('aria-describedby')
    expect(hintId).toBe('resize-keyboard-hint-2')

    const hint = box.querySelector(`#${hintId}`)
    expect(hint?.textContent).toContain('Hold Shift to overwrite')
  })
})
