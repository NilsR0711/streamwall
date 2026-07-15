import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { GridInput } from './GridInput.tsx'

let container: HTMLDivElement | undefined

afterEach(() => {
  if (container) {
    act(() => render(null, container!))
    container.remove()
    container = undefined
  }
})

function renderInput(
  props: Partial<Parameters<typeof GridInput>[0]> = {},
): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    render(
      <GridInput
        style={{}}
        idx={0}
        onChangeSpace={() => {}}
        spaceValue=""
        isHighlighted={false}
        role="admin"
        onPointerDown={() => {}}
        onFocus={() => {}}
        onBlur={() => {}}
        {...props}
      />,
      container!,
    )
  })
  return container
}

describe('GridInput', () => {
  test('invokes onPointerDown for pointer interactions, enabling touch drag-move', () => {
    const onPointerDown = vi.fn()
    const box = renderInput({ onPointerDown })
    const input = box.querySelector('input')!

    input.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }),
    )

    expect(onPointerDown).toHaveBeenCalledTimes(1)
  })

  test('does not rely on mousedown, so a touch-only pointerdown alone is enough to start a drag', () => {
    const onPointerDown = vi.fn()
    const box = renderInput({ onPointerDown })
    const input = box.querySelector('input')!

    input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))

    expect(onPointerDown).not.toHaveBeenCalled()
  })

  // The E2E suite (packages/streamwall-control-e2e) targets cells via these
  // hooks instead of styled-components class names, so a markup/styling
  // refactor can't silently break it (issue #344).
  test('exposes a stable data-testid and data-idx for E2E cell targeting', () => {
    const box = renderInput({ idx: 3 })
    const input = box.querySelector('input')!

    expect(input.getAttribute('data-testid')).toBe('grid-cell')
    expect(input.getAttribute('data-idx')).toBe('3')
  })
})
