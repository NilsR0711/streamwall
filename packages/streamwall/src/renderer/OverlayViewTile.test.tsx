// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import type { StreamData } from 'streamwall-shared'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { OverlayViewTile } from './OverlayViewTile'

// Unlike react-icons and styled-components (see vitest.config.ts),
// svg-loaders-react ships CJS only, so it has no ESM build for Vite's
// resolver to route through the `react` -> `preact/compat` alias - it always
// resolves the real `react` package, which crashes when preact/compat's
// forwardRef-wrapped `styled(TailSpin)` renders it. Stub it out so the
// tile's own rendering logic can be exercised in isolation.
vi.mock('svg-loaders-react', () => ({
  TailSpin: () => null,
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
    expect(tile.querySelector('svg')).toBeNull()
  })
})
