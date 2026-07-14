import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, test } from 'vitest'
import { GlobalStyle } from './globalStyle.tsx'

let container: HTMLDivElement | undefined

afterEach(() => {
  if (container) {
    act(() => render(null, container!))
    container.remove()
    container = undefined
  }
  document
    .querySelectorAll('style[data-styled]')
    .forEach((style) => style.remove())
})

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
    container = document.createElement('div')
    document.body.appendChild(container)

    act(() => {
      render(<GlobalStyle />, container!)
    })

    const css = Array.from(document.querySelectorAll('style'))
      .map((style) => style.textContent)
      .join('\n')

    expect(css).toMatch(/html,\s*body\s*{[^}]*margin:\s*0/)
    expect(css).toMatch(/html,\s*body\s*{[^}]*min-width:\s*0/)
  })
})
