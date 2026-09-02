import { render } from 'preact'
import { act } from 'preact/test-utils'
import { MAX_BLOCKED_LAYER_URLS } from 'streamwall-shared'
import { afterEach, describe, expect, test } from 'vitest'
import { BlockedLayerURLNotice } from './BlockedLayerURLNotice.tsx'

let container: HTMLDivElement | undefined

afterEach(() => {
  if (container) {
    act(() => render(null, container!))
    container.remove()
    container = undefined
  }
})

function renderNotice(urls: readonly string[]): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  rerender(urls)
  return container
}

function rerender(urls: readonly string[]): void {
  act(() => {
    render(<BlockedLayerURLNotice urls={urls} />, container!)
  })
}

function shownURLs(el: HTMLDivElement): (string | null)[] {
  return [...el.querySelectorAll('.blocked-layer-url')].map(
    (node) => node.textContent,
  )
}

function dismissButton(el: HTMLDivElement): HTMLButtonElement | null {
  return el.querySelector('button')
}

describe('BlockedLayerURLNotice', () => {
  test('names every refused URL', () => {
    const el = renderNotice([
      'http://192.168.1.5/overlay',
      'http://169.254.169.254/meta',
    ])

    expect(shownURLs(el)).toEqual([
      'http://192.168.1.5/overlay',
      'http://169.254.169.254/meta',
    ])
  })

  // `aria-live` only guarantees an announcement for content that changes
  // inside an already-present region, so the region stays mounted (empty)
  // while nothing is refused (WCAG 4.1.3, issue #463).
  test('keeps the live region mounted while nothing is refused', () => {
    const el = renderNotice([])
    const region = el.querySelector('[role="status"]')

    expect(region).not.toBeNull()
    expect(region?.getAttribute('aria-live')).toBe('polite')
    expect(shownURLs(el)).toEqual([])
    expect(dismissButton(el)).toBeNull()
  })

  test('reuses the same live region element when a URL is refused', () => {
    const el = renderNotice([])
    const regionWhileQuiet = el.querySelector('[role="status"]')

    rerender(['http://192.168.1.5/overlay'])

    expect(el.querySelector('[role="status"]')).toBe(regionWhileQuiet)
  })

  // The URL is reported by whatever the layer framed, so it must never become
  // something the operator can be induced to follow.
  test('renders a refused URL as text, never as a link', () => {
    const el = renderNotice(['http://192.168.1.5/overlay'])

    expect(el.querySelector('a')).toBeNull()
  })

  // The desktop stops collecting once the list is full, so the operator must
  // not read five addresses as "these are all of them".
  test('says so when the list is full', () => {
    const el = renderNotice(
      Array.from(
        { length: MAX_BLOCKED_LAYER_URLS },
        (_unused, i) => `http://192.168.1.5/${i}`,
      ),
    )

    expect(el.querySelector('.blocked-layer-capped')).not.toBeNull()
  })

  // What matters is what the desktop collected, not what survived dismissal:
  // its list is full, so it is dropping every further refusal, and the
  // operator has to be told that even while looking at fewer addresses.
  test('still says the list is full when only some entries are visible', () => {
    const dismissedFirst = Array.from(
      { length: MAX_BLOCKED_LAYER_URLS - 2 },
      (_unused, i) => `http://192.168.1.5/${i}`,
    )
    const el = renderNotice(dismissedFirst)
    act(() => {
      dismissButton(el)!.click()
    })

    rerender([...dismissedFirst, 'http://10.0.0.9/a', 'http://10.0.0.9/b'])

    expect(shownURLs(el)).toEqual(['http://10.0.0.9/a', 'http://10.0.0.9/b'])
    expect(el.querySelector('.blocked-layer-capped')).not.toBeNull()
  })

  test('says nothing about a full list while there is room', () => {
    const el = renderNotice(['http://192.168.1.5/overlay'])

    expect(el.querySelector('.blocked-layer-capped')).toBeNull()
  })

  test('dismisses the notice on the operator ask', () => {
    const el = renderNotice(['http://192.168.1.5/overlay'])

    act(() => {
      dismissButton(el)!.click()
    })

    expect(shownURLs(el)).toEqual([])
  })

  test('still names a URL refused after an earlier one was dismissed', () => {
    const el = renderNotice(['http://192.168.1.5/overlay'])
    act(() => {
      dismissButton(el)!.click()
    })

    rerender(['http://192.168.1.5/overlay', 'http://10.0.0.9/bg'])

    expect(shownURLs(el)).toEqual(['http://10.0.0.9/bg'])
  })

  // The desktop clears the list when the operator edits a layer link. If the
  // same address is refused again after that edit, the dismissal must not
  // still be suppressing it.
  test('names an address again once it is refused after a cleared list', () => {
    const el = renderNotice(['http://192.168.1.5/overlay'])
    act(() => {
      dismissButton(el)!.click()
    })

    rerender([])
    rerender(['http://192.168.1.5/overlay'])

    expect(shownURLs(el)).toEqual(['http://192.168.1.5/overlay'])
  })
})
