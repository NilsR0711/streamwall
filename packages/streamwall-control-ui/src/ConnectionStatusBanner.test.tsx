import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ConnectionStatusBanner } from './ConnectionStatusBanner.tsx'

vi.mock('react-icons/fa', () => ({
  FaExclamationTriangle: () => null,
  FaSyncAlt: () => null,
}))

let container: HTMLDivElement | undefined

afterEach(() => {
  if (container) {
    act(() => render(null, container!))
    container.remove()
    container = undefined
  }
})

function renderBanner(
  connectionStatus: Parameters<typeof ConnectionStatusBanner>[0]['connectionStatus'],
  hasKnownState: boolean,
): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    render(
      <ConnectionStatusBanner
        connectionStatus={connectionStatus}
        hasKnownState={hasKnownState}
      />,
      container!,
    )
  })
  return container
}

describe('ConnectionStatusBanner', () => {
  test('renders nothing once connected', () => {
    const el = renderBanner('connected', true)
    expect(el.querySelector('.connection-status-banner')).toBeNull()
  })

  test('renders nothing during the very first connect, before any state has ever arrived', () => {
    const el = renderBanner('connecting', false)
    expect(el.querySelector('.connection-status-banner')).toBeNull()
  })

  test('warns while reconnecting after having shown state before', () => {
    const el = renderBanner('reconnecting', true)
    const banner = el.querySelector('.connection-status-banner')
    expect(banner).not.toBeNull()
    expect(banner?.className).toContain('warning')
    expect(banner?.textContent).toMatch(/reconnect/i)
  })

  test('flags unauthorized as a severe, non-retrying failure', () => {
    const el = renderBanner('unauthorized', true)
    const banner = el.querySelector('.connection-status-banner')
    expect(banner).not.toBeNull()
    expect(banner?.className).toContain('severe')
    expect(banner?.textContent).toMatch(/session|reload|invite/i)
  })

  test('flags a disconnected streamwall app as severe', () => {
    const el = renderBanner('server-down', true)
    const banner = el.querySelector('.connection-status-banner')
    expect(banner).not.toBeNull()
    expect(banner?.className).toContain('severe')
    expect(banner?.textContent).toMatch(/streamwall app/i)
  })
})
