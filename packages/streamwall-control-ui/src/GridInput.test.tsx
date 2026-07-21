import { type ComponentChildren, render } from 'preact'
import { act } from 'preact/test-utils'
import { asCellIdx, Color, focusRingColors, idColor } from 'streamwall-shared'
import { StyleSheetManager } from 'styled-components'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { cellColor, GridInput } from './GridInput.tsx'
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

  test('paints the tile lighter while it is highlighted', () => {
    expect(cellColor(idColor('stream-1')).lightness()).toBe(75)
    expect(cellColor(idColor('stream-1'), true).lightness()).toBe(90)
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

    // The ring is drawn outside the cell, so it lands on the neighbouring
    // tiles - whose colour is whatever their stream id hashes to. The accent
    // token is a red, leaving it at roughly 2:1 against a red-ish neighbour
    // (#557), so the grid derives a contrast-safe pair from the tile while
    // keeping the shared rule's shape (2px ring plus 4px halo).
    test('recolours the shared ring from the tile instead of using the accent', () => {
      renderInput({ spaceValue: 'stream-1' })

      const rule = ownFocusVisibleRule(collectCss())
      const { ring, halo } = focusRingColors(cellColor(idColor('stream-1')))

      expect(rule).toBeDefined()
      expect(rule!.body).not.toMatch(/var\(--accent/)
      // Only the colour is overridden; the width/style stay with the shared
      // rule, so an unwanted `outline` shorthand would drop its 2px ring.
      expect(rule!.body).not.toMatch(/outline:/)
      expect(rule!.body.toLowerCase()).toMatch(
        new RegExp(`outline-color:\\s*${ring.toLowerCase()}`),
      )
      expect(rule!.body.toLowerCase()).toMatch(
        new RegExp(`box-shadow:\\s*0 0 0 4px\\s*${halo.toLowerCase()}`),
      )
    })

    test('keeps the derived ring above 3:1 against every tile the id space can paint', () => {
      const ids = [
        '',
        'stream-1',
        'streamwall',
        'https://twitch.tv/somechannel',
        ...Array.from({ length: 64 }, (_, i) => `id-${i}`),
      ]
      const tiles = ids.flatMap((id) => [
        cellColor(idColor(id)),
        cellColor(idColor(id), true),
      ])

      for (const tile of tiles) {
        const { ring } = focusRingColors(tile)
        // The ring sits on the neighbours, so it has to clear 3:1 against
        // every colour the grid can paint - not just against its own cell.
        for (const neighbour of tiles) {
          expect(neighbour.contrast(Color(ring))).toBeGreaterThanOrEqual(3)
        }
      }
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

    test('is covered by the shared ring from GlobalStyle, whose shape it keeps', () => {
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
