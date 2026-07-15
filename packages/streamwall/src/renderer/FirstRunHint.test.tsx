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
  const onCreateExampleConfig = vi.fn().mockResolvedValue(undefined)
  const onDismiss = vi.fn()
  const mergedProps = {
    configPath: '/home/test/.config/Streamwall/config.toml',
    onOpenConfigFolder,
    onCreateExampleConfig,
    onDismiss,
    ...props,
  }
  act(() => {
    render(<FirstRunHint {...mergedProps} />, container!)
  })
  return {
    onOpenConfigFolder: mergedProps.onOpenConfigFolder,
    onCreateExampleConfig: mergedProps.onCreateExampleConfig,
    onDismiss: mergedProps.onDismiss,
  }
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve()
  })
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

  test('creates the example config when its action button is clicked, then confirms success', async () => {
    const { onCreateExampleConfig } = renderHint()

    const button = container!.querySelector(
      'button[data-testid="create-example-config"]',
    ) as HTMLButtonElement
    act(() => button.click())
    await flushMicrotasks()

    expect(onCreateExampleConfig).toHaveBeenCalledTimes(1)
    expect(container!.textContent).toContain('restart Streamwall')
    expect(
      container!.querySelector('button[data-testid="create-example-config"]'),
    ).toBeNull()
  })

  test('shows an inline error instead of dismissing when creating the example config fails', async () => {
    const { onCreateExampleConfig } = renderHint({
      onCreateExampleConfig: vi.fn().mockRejectedValue(new Error('EEXIST')),
    })

    const button = container!.querySelector(
      'button[data-testid="create-example-config"]',
    ) as HTMLButtonElement
    act(() => button.click())
    await flushMicrotasks()

    expect(onCreateExampleConfig).toHaveBeenCalledTimes(1)
    expect(container!.textContent).toContain("Couldn't create")
    // The banner stays up so the user can still open the folder or dismiss.
    expect(
      container!.querySelector('button[data-testid="open-config-folder"]'),
    ).not.toBeNull()
  })
})
