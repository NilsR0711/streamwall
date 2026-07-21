import { type ComponentChildren, render } from 'preact'
import { act } from 'preact/test-utils'
import { StyleSheetManager } from 'styled-components'
import { afterEach, describe, expect, test } from 'vitest'

import { type useTileDrag } from '../useTileDrag.ts'
import { type useTileResize } from '../useTileResize.ts'
import { ControlGrid } from './ControlGrid.tsx'

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

const tileDrag: ReturnType<typeof useTileDrag> = {
  hoveringIdx: undefined,
  swapStartIdx: undefined,
  moveStart: undefined,
  moveTargetIdx: undefined,
  updateHoveringIdx: () => {},
  clearHoveringIdx: () => {},
  handleSwapView: () => {},
  handleGridPointerDown: () => {},
}

const tileResize: ReturnType<typeof useTileResize> = {
  resize: undefined,
  handleResizeStart: () => {},
  handleResizeKeyDown: () => {},
}

function renderGrid(): HTMLDivElement {
  return renderWithStyles(
    <ControlGrid
      cols={2}
      rows={1}
      windowWidth={800}
      windowHeight={400}
      role="admin"
      showDebug={false}
      sharedState={undefined}
      views={[]}
      stateIdxMap={new Map()}
      streams={[]}
      fullscreenViewIdx={null}
      tileDrag={tileDrag}
      tileResize={tileResize}
      onSetView={() => {}}
      onFocusInput={() => {}}
      onBlurInput={() => {}}
      onToggleFullscreen={() => {}}
      onSetListening={() => {}}
      onSetBackgroundListening={() => {}}
      onSetBlurred={() => {}}
      onSetVolume={() => {}}
      onReloadView={() => {}}
      onRotateView={() => {}}
      onBrowse={() => {}}
      onDevTools={() => {}}
    />,
  )
}

/** The layer holding the per-cell placement inputs (`StyledGridInputs`). */
function inputLayer(box: HTMLDivElement): HTMLElement {
  return box.querySelector('input')!.parentElement!.parentElement!
}

function collectCss(): string {
  return Array.from(document.querySelectorAll('style'))
    .map((style) => style.textContent)
    .join('\n')
}

/**
 * Returns the `{ selector, body }` pairs of every rule whose selector contains
 * `pseudo` and whose descendant part matches `element` - i.e. the rules that
 * would apply to that element once the pseudo-class is satisfied.
 */
function rulesFor(
  css: string,
  pseudo: string,
  element: Element,
): { selector: string; body: string; index: number }[] {
  return Array.from(css.matchAll(/([^{}]+){([^}]*)}/g))
    .filter(([, selector]) => selector.includes(pseudo))
    .map(([, selector, body]) => ({
      selector: selector.trim(),
      body,
      index: css.indexOf(selector),
    }))
    .filter(({ selector }) =>
      element.matches(selector.replaceAll(pseudo, '').replaceAll(/\s+/g, ' ')),
    )
}

describe('ControlGrid', () => {
  // The placement inputs render at `opacity: 0` and used to fade in on
  // `:hover` only, so a keyboard user tabbing into a cell focused a fully
  // transparent control - the cell value and the `:focus-visible` ring added in
  // #531 were both unpaintable without a pointer (WCAG 2.4.7, issue #551).
  describe('keyboard focus visibility', () => {
    test('reveals the cell input layer while it holds focus', () => {
      const box = renderGrid()
      const inputs = inputLayer(box)

      const rules = rulesFor(collectCss(), ':focus-within', inputs)

      expect(rules).toHaveLength(1)
      expect(rules[0]!.body).toMatch(/opacity:\s*1\b/)
    })

    test('wins over the hover rule, which would otherwise dilute the focus ring', () => {
      const box = renderGrid()
      const inputs = inputLayer(box)
      const css = collectCss()

      const hover = rulesFor(css, ':hover', inputs)
      const focusWithin = rulesFor(css, ':focus-within', inputs)

      expect(hover).toHaveLength(1)
      expect(focusWithin).toHaveLength(1)
      // Equal specificity (one class plus one pseudo-class on the container,
      // one class on the layer), so the later rule is the one that applies.
      expect(focusWithin[0]!.index).toBeGreaterThan(hover[0]!.index)
    })
  })
})
