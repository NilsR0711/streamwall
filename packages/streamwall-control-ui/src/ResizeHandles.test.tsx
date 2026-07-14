import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ResizeHandles } from './index.tsx'

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
        anchorIdx={0}
        originalSpaces={[0]}
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

  test('gives every resize handle a descriptive aria-label', () => {
    const box = renderHandles()

    expect(
      box.querySelector('button[aria-label="Resize right edge"]'),
    ).not.toBeNull()
    expect(
      box.querySelector('button[aria-label="Resize bottom edge"]'),
    ).not.toBeNull()
    expect(
      box.querySelector('button[aria-label="Resize bottom-right corner"]'),
    ).not.toBeNull()
  })
})
