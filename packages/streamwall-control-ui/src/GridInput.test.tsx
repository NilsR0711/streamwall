import { type ComponentChildren, render } from 'preact'
import { act } from 'preact/test-utils'
import { asCellIdx } from 'streamwall-shared'
import { StyleSheetManager } from 'styled-components'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { GridInput } from './GridInput.tsx'
import { GlobalStyle } from './globalStyle.tsx'

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

/**
 * Renders into a fresh container with its own styled-components target, so the
 * emitted CSS can be inspected. The dedicated target matters: styled-components
 * remembers what it already injected, so without a new sheet per test only the
 * first render would emit any CSS at all.
 */
function renderWithStyles(node: ComponentChildren): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  styleTarget = document.createElement('div')
  document.head.appendChild(styleTarget)

  act(() => {
    render(
      <StyleSheetManager target={styleTarget}>{node}</StyleSheetManager>,
      container!,
    )
  })
  return container
}

function gridInput(
  props: Partial<Parameters<typeof GridInput>[0]> = {},
): ComponentChildren {
  return (
    <GridInput
      style={{}}
      idx={asCellIdx(0)}
      onChangeSpace={() => {}}
      spaceValue=""
      isHighlighted={false}
      role="admin"
      onPointerDown={() => {}}
      onFocus={() => {}}
      onBlur={() => {}}
      {...props}
    />
  )
}

function renderInput(
  props: Partial<Parameters<typeof GridInput>[0]> = {},
): HTMLDivElement {
  return renderWithStyles(gridInput(props))
}

function collectCss(): string {
  return Array.from(document.querySelectorAll('style'))
    .map((style) => style.textContent)
    .join('\n')
}

type FocusVisibleRule = { selectors: string[]; body: string }

/**
 * Extracts every `:focus-visible` rule and reduces its selectors to the plain-
 * element part, so a test can check which elements a rule matches
 * (`:focus-visible` itself never matches in a non-interactive DOM). Rules whose
 * selector also carries `:not(:focus-visible)` are the idle-state rules and are
 * skipped.
 */
function focusVisibleRules(css: string): FocusVisibleRule[] {
  return Array.from(css.matchAll(/([^{}]*:focus-visible[^{}]*){([^}]*)}/g))
    .filter(([, selector]) => !selector.includes(':not(:focus-visible)'))
    .map(([, selector, body]) => ({
      selectors: selector
        .split(',')
        .map((one) => one.replaceAll(':focus-visible', '').trim())
        .map((one) => one || '*'),
      body,
    }))
}

/** The single `:focus-visible` rule the component itself contributes. */
function ownFocusVisibleRule(css: string): FocusVisibleRule | undefined {
  const rules = focusVisibleRules(css)
  expect(rules).toHaveLength(1)
  return rules[0]
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
    const box = renderInput({ idx: asCellIdx(3) })
    const input = box.querySelector('input')!

    expect(input.getAttribute('data-testid')).toBe('grid-cell')
    expect(input.getAttribute('data-idx')).toBe('3')
  })

  // The cell used to draw its own hardcoded `outline: 1px solid black` /
  // `box-shadow: ... black inset` on `:focus`, which fired on pointer
  // interaction too and out-specified the shared `:focus-visible` ring added
  // in #508 - leaving the grid as the one place in the control UI with a
  // different, non-token keyboard affordance (#531).
  describe('keyboard focus affordance', () => {
    test('does not style a bare :focus, so pointer interaction draws no keyboard ring', () => {
      renderInput()

      // `:focus` not followed by `-visible`.
      expect(collectCss()).not.toMatch(/:focus(?!-visible)/)
    })

    test('does not hardcode a focus colour, leaving the shared accent ring to apply', () => {
      renderInput()

      const rule = ownFocusVisibleRule(collectCss())

      expect(rule).toBeDefined()
      expect(rule!.body).not.toMatch(/black/)
      expect(rule!.body).not.toMatch(/outline:/)
      expect(rule!.body).not.toMatch(/box-shadow:/)
    })

    test('confines the idle cell border to :not(:focus-visible) so it cannot beat the shared ring', () => {
      renderInput()

      // Both the component class and the global `:focus-visible` rule are
      // single-pseudo-class selectors, so an unscoped `outline` on the class
      // would win or lose purely by injection order.
      expect(collectCss()).toMatch(
        /:not\(:focus-visible\)\s*{[^}]*outline:\s*1px solid/,
      )
    })

    test('raises the focused cell above its neighbours so the ring is not clipped', () => {
      renderInput()

      const rule = ownFocusVisibleRule(collectCss())

      expect(rule).toBeDefined()
      // `z-index` only applies to positioned elements; the input itself is
      // static, so it needs `position` alongside it to actually stack.
      expect(rule!.body).toMatch(/position:\s*relative/)
      expect(rule!.body).toMatch(/z-index:\s*100/)
    })

    test('is covered by the shared accent ring from GlobalStyle', () => {
      renderWithStyles(
        <>
          <GlobalStyle />
          {gridInput()}
        </>,
      )

      const input = container!.querySelector('input')!
      const rule = focusVisibleRules(collectCss()).find(({ body }) =>
        body.includes('--accent'),
      )

      expect(rule).toBeDefined()
      expect(rule!.body).toMatch(/outline:\s*2px solid var\(--accent\)/)
      expect(rule!.body).toMatch(/var\(--accent-soft\)/)
      expect(rule!.selectors.some((selector) => input.matches(selector))).toBe(
        true,
      )
    })
  })
})
