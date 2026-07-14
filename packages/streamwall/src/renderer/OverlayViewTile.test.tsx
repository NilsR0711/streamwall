// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import type { StreamData } from 'streamwall-shared'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { OverlayViewTile } from './OverlayViewTile'

// react-icons renders through preact/compat's Context.Consumer, which
// currently crashes under the happy-dom test environment (unrelated to the
// markup under test here) - stub the icons out so the tile's own rendering
// logic can be exercised in isolation.
vi.mock('react-icons/fa', () => ({
  FaExclamationTriangle: () => <i data-icon="warning" />,
  FaFacebook: () => null,
  FaInstagram: () => null,
  FaMapMarkerAlt: () => null,
  FaTiktok: () => null,
  FaTwitch: () => null,
  FaVolumeUp: () => null,
  FaYoutube: () => null,
}))
vi.mock('react-icons/ri', () => ({
  RiKickFill: () => null,
  RiTwitterXFill: () => null,
}))

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
    expect(tile.querySelector('[data-icon="warning"]')).not.toBeNull()
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
    expect(tile.querySelector('[data-icon="warning"]')).toBeNull()
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
