// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { FirstRunHint } from './FirstRunHint'

let container: HTMLDivElement | undefined

afterEach(() => {
  if (container) {
    act(() => render(null, container!))
    container.remove()
    container = undefined
  }
})

function renderHint(props: Partial<Parameters<typeof FirstRunHint>[0]> = {}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  const onOpenConfigFolder = vi.fn()
  const onDismiss = vi.fn()
  act(() => {
    render(
      <FirstRunHint
        configPath="/home/test/.config/Streamwall/config.toml"
        onOpenConfigFolder={onOpenConfigFolder}
        onDismiss={onDismiss}
        {...props}
      />,
      container!,
    )
  })
  return { onOpenConfigFolder, onDismiss }
}

describe('FirstRunHint', () => {
  test('shows the userData config path so a first-time user knows where to add streams', () => {
    renderHint({
      configPath: '/home/test/.config/Streamwall/config.toml',
    })

    expect(container!.textContent).toContain(
      '/home/test/.config/Streamwall/config.toml',
    )
  })

  test('opens the config folder when its action button is clicked', () => {
    const { onOpenConfigFolder } = renderHint()

    const button = container!.querySelector(
      'button[data-testid="open-config-folder"]',
    ) as HTMLButtonElement
    act(() => button.click())

    expect(onOpenConfigFolder).toHaveBeenCalledTimes(1)
  })

  test('dismisses the hint when its close button is clicked', () => {
    const { onDismiss } = renderHint()

    const button = container!.querySelector(
      'button[data-testid="dismiss-first-run-hint"]',
    ) as HTMLButtonElement
    act(() => button.click())

    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
