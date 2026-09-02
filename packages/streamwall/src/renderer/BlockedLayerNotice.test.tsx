// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, test } from 'vitest'
import { BlockedLayerNotices, MAX_SHOWN_URL_LENGTH } from './BlockedLayerNotice'

let container: HTMLDivElement | undefined

afterEach(() => {
  if (container) {
    act(() => render(null, container!))
    container.remove()
    container = undefined
  }
})

function renderNotices(urls: readonly string[]): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    render(<BlockedLayerNotices urls={urls} />, container!)
  })
  return container
}

describe('BlockedLayerNotices', () => {
  test('renders nothing while no URL has been refused', () => {
    const root = renderNotices([])

    expect(root.textContent).toBe('')
  })

  test('names every refused URL and says why once', () => {
    const root = renderNotices([
      'http://192.168.1.50/overlay',
      'http://169.254.169.254/meta',
    ])

    expect(root.textContent).toContain('http://192.168.1.50/overlay')
    expect(root.textContent).toContain('http://169.254.169.254/meta')
    expect(root.textContent).toContain('not a public address')
  })

  test('shows every refused URL rather than only the most recent', () => {
    const root = renderNotices([
      'http://192.168.1.50/a',
      'http://192.168.1.50/b',
      'http://192.168.1.50/c',
    ])

    expect(root.querySelectorAll('[role="alert"] > div')).toHaveLength(3)
  })

  test('truncates a URL long enough to wrap its way across the wall', () => {
    // The content is supplied by whatever the layer is framing, and a framed
    // page can request an arbitrarily long URL.
    const long = `http://192.168.1.50/${'a'.repeat(5000)}`
    const root = renderNotices([long])

    const shown = root.querySelector('[role="alert"] > div')!.textContent!
    expect(shown.length).toBeLessThanOrEqual(MAX_SHOWN_URL_LENGTH + 1)
    expect(shown.startsWith('http://192.168.1.50/')).toBe(true)
  })

  test('is announced as an alert, so it is not just decoration', () => {
    const root = renderNotices(['http://192.168.1.50/overlay'])

    expect(root.querySelector('[role="alert"]')).not.toBeNull()
  })
})
