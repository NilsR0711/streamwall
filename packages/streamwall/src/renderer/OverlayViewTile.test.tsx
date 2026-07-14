// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import type { StreamData } from 'streamwall-shared'
import { afterEach, describe, expect, test } from 'vitest'
import { OverlayViewTile } from './OverlayViewTile'

let container: HTMLDivElement | undefined

afterEach(() => {
  if (container) {
    act(() => render(null, container!))
    container.remove()
    container = undefined
  }
})

function renderTile(
  props: Partial<Parameters<typeof OverlayViewTile>[0]> = {},
): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    render(
      <OverlayViewTile
        url="https://example.com/stream"
        data={undefined}
        isError={false}
        errorReason={null}
        isListening={false}
        isBackgroundListening={false}
        isBlurred={false}
        isLoading={false}
        activeColor="#fff"
        {...props}
      />,
      container!,
    )
  })
  return container
}

describe('OverlayViewTile', () => {
  test('renders the error badge and reason for an errored view', () => {
    const data: StreamData = {
      _id: 'a',
      _dataSource: 'test',
      kind: 'video',
      link: 'https://example.com/stream',
      source: 'Example',
      label: 'Example Stream',
    }
    const tile = renderTile({
      data,
      isError: true,
      errorReason: 'Stream unavailable',
    })

    expect(tile.textContent).toContain('Example Stream')
    expect(tile.textContent).toContain('Stream unavailable')
    expect(tile.querySelector('svg')).not.toBeNull()
  })

  test('falls back to a generic label when the errored stream has no title', () => {
    const tile = renderTile({
      data: undefined,
      isError: true,
      errorReason: null,
    })

    expect(tile.textContent).toContain('Stream error')
    // No reason was provided, so the heading is the only text rendered.
    expect(tile.textContent).toBe('Stream error')
  })

  test('does not render the error badge for a non-error view', () => {
    const data: StreamData = {
      _id: 'a',
      _dataSource: 'test',
      kind: 'video',
      link: 'https://example.com/stream',
      source: 'Example',
      label: 'Example Stream',
    }
    const tile = renderTile({
      data,
      isError: false,
      errorReason: null,
    })

    expect(tile.textContent).not.toContain('Stream error')
    expect(tile.textContent).not.toContain('Stream unavailable')
    expect(tile.textContent).toContain('Example Stream')
    // The loading spinner is always present in the DOM (visibility is
    // toggled via CSS, see the isLoading tests below); it's the only svg
    // expected here since the URL doesn't match a known platform icon.
    const svgs = tile.querySelectorAll('svg')
    expect(svgs).toHaveLength(1)
    expect(svgs[0].querySelector('circle')).not.toBeNull()
  })

  test('shows the loading spinner while isLoading is true', () => {
    const tile = renderTile({ isLoading: true })

    const spinner = tile.querySelector('svg circle')?.closest('svg')
    expect(spinner).not.toBeNull()
    expect(getComputedStyle(spinner!).opacity).toBe('0.5')
    expect(getComputedStyle(spinner!).visibility).toBe('visible')
  })

  test('hides the loading spinner while isLoading is false', () => {
    const tile = renderTile({ isLoading: false })

    const spinner = tile.querySelector('svg circle')?.closest('svg')
    expect(spinner).not.toBeNull()
    expect(getComputedStyle(spinner!).opacity).toBe('0')
    expect(getComputedStyle(spinner!).visibility).toBe('hidden')
  })

  test('does not leak custom styled-component props onto the DOM nodes (#152)', () => {
    const data: StreamData = {
      _id: 'a',
      _dataSource: 'test',
      kind: 'video',
      link: 'https://example.com/stream',
      source: 'Example',
      label: 'Example Stream',
      city: 'Portland',
      state: 'OR',
    }
    const tile = renderTile({
      data,
      isError: false,
      isListening: true,
      isBlurred: true,
      isLoading: true,
      activeColor: '#f00',
    })

    for (const el of tile.querySelectorAll('*')) {
      for (const propName of [
        'position',
        'islistening',
        'activecolor',
        'isvisible',
        'isblurred',
        'isdesaturated',
      ]) {
        expect(
          el.hasAttribute(propName),
          `<${el.tagName.toLowerCase()}> unexpectedly has a "${propName}" attribute`,
        ).toBe(false)
      }
    }
  })
})
