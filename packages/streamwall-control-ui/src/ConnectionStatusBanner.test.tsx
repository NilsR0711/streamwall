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
  test('renders no message while connected', () => {
    const el = renderBanner({ isConnected: true, reason: null })
    expect(
      el.querySelector('[data-testid="connection-status-banner"]'),
    ).toBeNull()
    expect(el.textContent).toBe('')
  })

  // `aria-live` only guarantees an announcement for content that changes
  // inside an already-present region, so the region stays mounted (empty)
  // while healthy - otherwise the first disconnect can go unannounced
  // (WCAG 4.1.3, issue #463).
  test('keeps the live region mounted while connected', () => {
    const el = renderBanner({ isConnected: true, reason: null })
    const region = el.querySelector('[role="status"]')
    expect(region).not.toBeNull()
    expect(region?.getAttribute('aria-live')).toBe('polite')
  })

  test('reuses the same live region element across a disconnect', () => {
    const el = renderBanner({ isConnected: true, reason: null })
    const regionWhileConnected = el.querySelector('[role="status"]')
    act(() => {
      render(
        <ConnectionStatusBanner isConnected={false} reason={null} />,
        container!,
      )
    })
    expect(el.querySelector('[role="status"]')).toBe(regionWhileConnected)
    expect(regionWhileConnected?.textContent).toContain('reconnecting')
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
    const banner = el.querySelector('[data-testid="connection-status-banner"]')
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
    const banner = el.querySelector('[data-testid="connection-status-banner"]')
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
