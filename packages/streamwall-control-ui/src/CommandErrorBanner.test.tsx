import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { CommandErrorBanner } from './CommandErrorBanner.tsx'

let container: HTMLDivElement | undefined

afterEach(() => {
  if (container) {
    act(() => render(null, container!))
    container.remove()
    container = undefined
  }
})

function renderBanner(
  error: string | null,
  onDismiss: () => void = () => {},
): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    render(
      <CommandErrorBanner error={error} onDismiss={onDismiss} />,
      container!,
    )
  })
  return container
}

describe('CommandErrorBanner', () => {
  test('renders no message when there is no error', () => {
    const el = renderBanner(null)
    expect(el.textContent).toBe('')
    expect(el.querySelector('.command-error-banner button')).toBeNull()
  })

  // `aria-live` only guarantees an announcement for content that changes
  // inside an already-present region, so the region stays mounted (empty)
  // while there is no error - otherwise the first command failure can go
  // unannounced (WCAG 4.1.3, issue #463).
  test('keeps the live region mounted while there is no error', () => {
    const el = renderBanner(null)
    const region = el.querySelector('.command-error-banner')
    expect(region).not.toBeNull()
    expect(region?.getAttribute('role')).toBe('alert')
    expect(region?.getAttribute('aria-live')).toBe('assertive')
  })

  test('reuses the same live region element when an error appears', () => {
    const el = renderBanner(null)
    const regionWhileHealthy = el.querySelector('.command-error-banner')
    act(() => {
      render(
        <CommandErrorBanner error="unauthorized" onDismiss={() => {}} />,
        container!,
      )
    })
    expect(el.querySelector('.command-error-banner')).toBe(regionWhileHealthy)
    expect(regionWhileHealthy?.textContent).toContain('unauthorized')
  })

  test('shows the error message when set', () => {
    const el = renderBanner('unauthorized')
    expect(el.querySelector('.command-error-banner')?.textContent).toContain(
      'unauthorized',
    )
  })

  test('renders English copy', () => {
    const el = renderBanner('unauthorized')
    const text = el.querySelector('.command-error-banner')?.textContent
    expect(text).toContain('Action failed: unauthorized')
    expect(text).not.toContain('Aktion fehlgeschlagen')
  })

  test('labels the dismiss button in English', () => {
    const el = renderBanner('unauthorized')
    const dismissButton = el.querySelector(
      '.command-error-banner button',
    ) as HTMLButtonElement
    expect(dismissButton.textContent).toBe('Dismiss')
  })

  test('calls onDismiss when the dismiss control is clicked', () => {
    const onDismiss = vi.fn()
    const el = renderBanner('unauthorized', onDismiss)
    const dismissButton = el.querySelector(
      '.command-error-banner button',
    ) as HTMLButtonElement
    act(() => {
      dismissButton.click()
    })
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  // A command failure is an urgent, user-triggered outcome, so it is
  // announced assertively to assistive technology (WCAG 4.1.3, issue #398).
  test('announces the failure assertively to assistive technology', () => {
    const el = renderBanner('unauthorized')
    const banner = el.querySelector('.command-error-banner')
    expect(banner?.getAttribute('role')).toBe('alert')
    expect(banner?.getAttribute('aria-live')).toBe('assertive')
  })
})
