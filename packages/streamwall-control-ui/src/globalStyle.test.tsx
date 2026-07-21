import { type ComponentChildren, render } from 'preact'
import { act } from 'preact/test-utils'
import { StyleSheetManager } from 'styled-components'
import { afterEach, describe, expect, test } from 'vitest'
import { StreamList } from './Sidebar.tsx'
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
 * Renders into a fresh container with its own styled-components target. The
 * dedicated target matters: styled-components remembers what it already
 * injected, so without a new sheet per test only the first render would emit
 * the global CSS these tests inspect.
 */
function renderWithStyles(node: ComponentChildren) {
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
}

// The browser default 8px body margin is never reset, so the flex shell (sized
// to the viewport) ends up wider than the viewport once that margin is added -
// producing a horizontal scrollbar on every page (see #225). GlobalStyle must
// reset it explicitly.
//
// Resetting the margin alone isn't enough: `body` is a flex item of `html`
// with no explicit `min-width`, so its automatic minimum size falls back to
// its content's min-content width, which can exceed the viewport and inflate
// `body` past it anyway (verified in a real browser: 1306px body in a 1280px
// viewport even with margin: 0). `min-width: 0` removes that content-based
// floor so `body` actually shrinks to fit the viewport.
describe('GlobalStyle', () => {
  test('resets the default body margin and min-width so the shell cannot exceed the viewport width', () => {
    renderWithStyles(<GlobalStyle />)

    const css = collectCss()

    expect(css).toMatch(/html,\s*body\s*{[^}]*margin:\s*0/)
    expect(css).toMatch(/html,\s*body\s*{[^}]*min-width:\s*0/)
  })

  // Inputs have carried an accent focus ring since the design system landed,
  // but buttons had none and fell back to the user-agent ring - which is
  // easily lost on the custom-coloured controls (sidebar handle, favorite
  // star, grid preset buttons); see #508. One shared `:focus-visible` rule
  // covers every focusable element instead.
  test('defines a shared focus-visible affordance built from the accent tokens', () => {
    renderWithStyles(<GlobalStyle />)

    const rule = focusVisibleRule(collectCss())

    expect(rule).toBeDefined()
    expect(rule!.body).toMatch(/outline:\s*2px solid var\(--accent\)/)
    expect(rule!.body).toMatch(/outline-offset:/)
    expect(rule!.body).toMatch(/var\(--accent-soft\)/)
  })

  test('applies that affordance to a custom-styled button such as the sidebar stream handle', () => {
    renderWithStyles(
      <>
        <GlobalStyle />
        <StreamList
          rows={[
            {
              _id: 'abc',
              _dataSource: 'example',
              kind: 'video',
              link: 'https://example.com/stream',
            },
          ]}
          disabled={false}
          onClickId={() => {}}
          favorites={new Set()}
        />
      </>,
    )

    const handle = container!.querySelector('button')
    expect(handle).not.toBeNull()

    const rule = focusVisibleRule(collectCss())
    expect(rule).toBeDefined()
    expect(rule!.selectors.some((selector) => handle!.matches(selector))).toBe(
      true,
    )
  })
})

function collectCss(): string {
  return Array.from(document.querySelectorAll('style'))
    .map((style) => style.textContent)
    .join('\n')
}

/**
 * Extracts the shared `:focus-visible` rule and reduces its selectors to the
 * plain-element part, so a test can check which elements the rule matches
 * (`:focus-visible` itself never matches in a non-interactive DOM).
 */
function focusVisibleRule(
  css: string,
): { selectors: string[]; body: string } | undefined {
  const match = /([^{}]*:focus-visible[^{}]*){([^}]*)}/.exec(css)
  if (!match) {
    return undefined
  }
  const selectors = match[1]
    .split(',')
    .map((selector) => selector.replaceAll(':focus-visible', '').trim())
    .map((selector) => selector || '*')
  return { selectors, body: match[2] }
}
