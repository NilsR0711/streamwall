import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ConnectionStatusBanner } from './ConnectionStatusBanner.tsx'

vi.mock('react-icons/fa', () => ({
  FaExclamationTriangle: () => null,
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
  props: Parameters<typeof ConnectionStatusBanner>[0],
): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    render(<ConnectionStatusBanner {...props} />, container!)
  })
  return container
}

describe('ConnectionStatusBanner', () => {
  test('renders nothing while connected', () => {
    const el = renderBanner({ isConnected: true, reason: null })
    expect(el.querySelector('[role="status"]')).toBeNull()
  })

  test('shows a generic reconnecting message with no reason', () => {
    const el = renderBanner({ isConnected: false, reason: null })
    const banner = el.querySelector('[role="status"]')
    expect(banner?.textContent).toContain('reconnecting')
  })

  test('shows a generic reconnecting message when reason is undefined', () => {
    const el = renderBanner({ isConnected: false, reason: undefined })
    const banner = el.querySelector('[role="status"]')
    expect(banner?.textContent).toContain('reconnecting')
  })

  test('distinguishes an unauthorized session from a generic disconnect', () => {
    const el = renderBanner({ isConnected: false, reason: 'unauthorized' })
    const banner = el.querySelector('[role="status"]')
    expect(banner?.textContent).toContain('Session invalid')
    expect(banner?.className).toContain('unauthorized')
  })

  test('distinguishes the Streamwall app being disconnected', () => {
    const el = renderBanner({
      isConnected: false,
      reason: 'streamwall-disconnected',
    })
    const banner = el.querySelector('[role="status"]')
    expect(banner?.textContent).toContain('Streamwall app disconnected')
  })

  test('distinguishes a rate-limited connection from a generic disconnect', () => {
    const el = renderBanner({ isConnected: false, reason: 'rate-limited' })
    const banner = el.querySelector('[role="status"]')
    expect(banner?.textContent).toContain('Too many messages')
    expect(banner?.className).toContain('rate-limited')
  })

  // The E2E suite targets the disconnect banner via this hook rather than
  // its `role="status"` (which stays for accessibility), so a markup
  // refactor can't silently break the test (issue #344).
  test('exposes a stable data-testid for E2E targeting', () => {
    const el = renderBanner({ isConnected: false, reason: null })
    expect(
      el.querySelector('[data-testid="connection-status-banner"]'),
    ).not.toBeNull()
  })
})
