import Color from 'color'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'

// `idColor` (from streamwall-shared) returns a `Color` instance built from
// *that* package's own `color` module copy — the monorepo doesn't dedupe it
// against this package's copy (see packages/streamwall-shared/node_modules/color
// vs packages/streamwall-control-ui/node_modules/color in package-lock.json).
// `GridInput`'s styled component then re-wraps it via `Color($color)...` using
// *this* package's copy, which can't parse an instance from the other copy.
// That's an unrelated, pre-existing cross-package bug (tracked separately);
// stub `idColor` here with a same-copy `Color` instance so this test isolates
// the pointer-event wiring this file is actually about.
vi.mock('streamwall-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('streamwall-shared')>()
  return { ...actual, idColor: () => Color('white') }
})

import { GridInput } from './index.tsx'

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
})
