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
  test('renders nothing when there is no error', () => {
    const el = renderBanner(null)
    expect(el.querySelector('.command-error-banner')).toBeNull()
  })

  test('shows the error message when set', () => {
    const el = renderBanner('unauthorized')
    expect(el.querySelector('.command-error-banner')?.textContent).toContain(
      'unauthorized',
    )
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
})
