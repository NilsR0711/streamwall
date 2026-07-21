import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ServerUpdateBanner } from './ServerUpdateBanner.tsx'
import { type ServerStatus } from './useServerStatus.ts'

let container: HTMLDivElement | undefined

const AVAILABLE_STATUS: ServerStatus = {
  version: '0.9.1',
  latestVersion: '1.0.0',
  updateAvailable: true,
  releaseUrl: 'https://github.com/NilsR0711/streamwall/releases/tag/v1.0.0',
  lastCheckedAt: '2026-07-20T09:00:00.000Z',
  checkEnabled: true,
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  if (container) {
    act(() => render(null, container!))
    container.remove()
    container = undefined
  }
  localStorage.clear()
})

function renderBanner(status: ServerStatus | null): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    render(<ServerUpdateBanner status={status} />, container!)
  })
  return container
}

describe('ServerUpdateBanner', () => {
  test('renders nothing when there is no status', () => {
    const el = renderBanner(null)
    expect(el.querySelector('.server-update-banner')).toBeNull()
  })

  test('renders nothing when no update is available', () => {
    const el = renderBanner({ ...AVAILABLE_STATUS, updateAvailable: false })
    expect(el.querySelector('.server-update-banner')).toBeNull()
  })

  test('renders nothing when the update check is disabled, even if the stale flag is set', () => {
    const el = renderBanner({
      ...AVAILABLE_STATUS,
      checkEnabled: false,
    })
    expect(el.querySelector('.server-update-banner')).toBeNull()
  })

  // `aria-live` only guarantees an announcement for content that changes
  // inside an already-present region, so the region stays mounted (empty)
  // while there is no update - otherwise the notice, which appears without
  // any user action once `GET /admin/status` resolves, can go unannounced
  // (WCAG 4.1.3, issue #502).
  test('keeps the live region mounted while there is no update', () => {
    const el = renderBanner({ ...AVAILABLE_STATUS, updateAvailable: false })
    const region = el.querySelector('[role="status"]')
    expect(region).not.toBeNull()
    expect(region?.getAttribute('aria-live')).toBe('polite')
    expect(el.textContent).toBe('')
  })

  test('reuses the same live region element when the notice appears', () => {
    const el = renderBanner({ ...AVAILABLE_STATUS, updateAvailable: false })
    const regionWithoutUpdate = el.querySelector('[role="status"]')
    act(() => {
      render(<ServerUpdateBanner status={AVAILABLE_STATUS} />, container!)
    })
    expect(el.querySelector('[role="status"]')).toBe(regionWithoutUpdate)
    expect(regionWithoutUpdate?.textContent).toContain('1.0.0')
  })

  test('announces an available update politely to assistive technology', () => {
    const el = renderBanner(AVAILABLE_STATUS)
    const region = el.querySelector('[role="status"]')
    expect(region).not.toBeNull()
    expect(region?.getAttribute('aria-live')).toBe('polite')
    expect(region?.textContent).toContain('1.0.0')
  })

  test('shows a notice linking to the release when an update is available', () => {
    const el = renderBanner(AVAILABLE_STATUS)
    const banner = el.querySelector('.server-update-banner')
    expect(banner?.textContent).toContain('1.0.0')
    expect(banner?.textContent).toContain('0.9.1')
    const link = banner?.querySelector('a') as HTMLAnchorElement
    expect(link.href).toBe(AVAILABLE_STATUS.releaseUrl)
  })

  test('renders English copy', () => {
    const el = renderBanner(AVAILABLE_STATUS)
    const text = el.querySelector('.server-update-banner')?.textContent
    expect(text).toContain('update')
    expect(text).not.toMatch(/aktualisierung|verfügbar/i)
  })

  test('dismissing the notice hides it', () => {
    const el = renderBanner(AVAILABLE_STATUS)
    const dismissButton = el.querySelector(
      '.server-update-banner button',
    ) as HTMLButtonElement
    act(() => {
      dismissButton.click()
    })
    expect(el.querySelector('.server-update-banner')).toBeNull()
  })

  test('a dismissal persists across remounts for the same release', () => {
    let el = renderBanner(AVAILABLE_STATUS)
    const dismissButton = el.querySelector(
      '.server-update-banner button',
    ) as HTMLButtonElement
    act(() => {
      dismissButton.click()
    })
    act(() => render(null, container!))
    el = renderBanner(AVAILABLE_STATUS)
    expect(el.querySelector('.server-update-banner')).toBeNull()
  })

  test('a newer release re-shows the notice after a prior dismissal', () => {
    let el = renderBanner(AVAILABLE_STATUS)
    const dismissButton = el.querySelector(
      '.server-update-banner button',
    ) as HTMLButtonElement
    act(() => {
      dismissButton.click()
    })
    act(() => render(null, container!))
    el = renderBanner({ ...AVAILABLE_STATUS, latestVersion: '1.1.0' })
    expect(el.querySelector('.server-update-banner')).not.toBeNull()
  })
})
