import { render } from 'preact'
import { act } from 'preact/test-utils'
import { Color, idColor } from 'streamwall-shared'
import { StyleSheetManager } from 'styled-components'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { focusRingColors, GridInput, tileColor } from './GridInput.tsx'

let container: HTMLDivElement | undefined
let styleTarget: HTMLDivElement | undefined

afterEach(() => {
  if (container) {
    act(() => render(null, container!))
    container.remove()
    container = undefined
  }
  styleTarget?.remove()
  styleTarget = undefined
  document
    .querySelectorAll('style[data-styled]')
    .forEach((style) => style.remove())
})

function renderInput(
  props: Partial<Parameters<typeof GridInput>[0]> = {},
): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  // Own styled-components target per render: the sheet remembers what it
  // already injected, so without it only the first test would see the CSS.
  styleTarget = document.createElement('div')
  document.head.appendChild(styleTarget)
  act(() => {
    render(
      <StyleSheetManager target={styleTarget}>
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
        />
      </StyleSheetManager>,
      container!,
    )
  })
  return container
}

function collectCss(): string {
  return Array.from(document.querySelectorAll('style'))
    .map((style) => style.textContent)
    .join('\n')
}

/** The rule the focused tile draws its ring from, or undefined if there is none. */
function focusVisibleRule(css: string): string | undefined {
  return /:focus-visible[^{}]*{([^}]*)}/.exec(css)?.[1]
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

// The tile ring used to be a hardcoded `1px solid black` behind a plain
// `:focus`, so it also appeared on pointer interaction and could disappear
// against a dark tile (#531). It now follows the shared affordance from
// globalStyle.tsx in shape and trigger, but derives its colour from the tile
// instead of using --accent: the tile hue comes from the stream id, so a fixed
// accent hue can land next to a near-identical one.
describe('GridInput focus affordance', () => {
  test('draws the ring only for keyboard focus, not for every :focus', () => {
    renderInput({ spaceValue: 'stream-1' })

    const css = collectCss()

    expect(focusVisibleRule(css)).toBeDefined()
    // `:focus-visible` itself contains `:focus`, hence the lookahead.
    expect(css).not.toMatch(/:focus(?![-\w])/)
  })

  test('replaces the hardcoded black ring with a 2px ring derived from the tile', () => {
    const spaceValue = 'stream-1'
    renderInput({ spaceValue })

    const rule = focusVisibleRule(collectCss())

    expect(rule).toBeDefined()
    expect(rule).not.toMatch(/black/)
    const ring = /outline:\s*2px solid ([^;]+);/.exec(rule!)?.[1]
    expect(ring).toBeDefined()
    expect(
      Color(ring!.trim()).contrast(tileColor(idColor(spaceValue))),
    ).toBeGreaterThanOrEqual(3)
  })

  test('keeps the ring inside the tile so neighbouring tiles cannot clip it', () => {
    renderInput({ spaceValue: 'stream-1' })

    expect(focusVisibleRule(collectCss())).toMatch(/outline-offset:\s*-2px/)
  })

  test('pairs the ring with a halo it contrasts against, so both edges stay legible', () => {
    renderInput({ spaceValue: 'stream-1' })

    const rule = focusVisibleRule(collectCss())!
    const ring = /outline:\s*2px solid ([^;]+);/.exec(rule)![1].trim()
    const halo = /box-shadow:[^;]*?(#[0-9a-fA-F]{3,8})\s+inset/.exec(rule)![1]

    expect(Color(ring).contrast(Color(halo))).toBeGreaterThanOrEqual(3)
  })
})

describe('focusRingColors', () => {
  test('clears WCAG 2.4.11 contrast against every tile colour the grid can paint', () => {
    const ids = ['', ...Array.from({ length: 64 }, (_, i) => `stream-${i}`)]

    for (const id of ids) {
      for (const isHighlighted of [false, true]) {
        const tile = tileColor(idColor(id), isHighlighted)
        const { ring, halo } = focusRingColors(tile)

        expect(Color(ring).contrast(tile)).toBeGreaterThanOrEqual(3)
        expect(Color(ring).contrast(Color(halo))).toBeGreaterThanOrEqual(3)
      }
    }
  })

  test('flips to a light ring on a dark tile instead of hardcoding black', () => {
    expect(focusRingColors(Color('#111111')).ring).toBe(Color('white').hex())
    expect(focusRingColors(Color('#eeeeee')).ring).toBe(Color('black').hex())
  })
})
