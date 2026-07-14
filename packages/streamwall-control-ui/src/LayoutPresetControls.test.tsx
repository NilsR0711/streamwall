import { render } from 'preact'
import { act } from 'preact/test-utils'
import type { LayoutPreset } from 'streamwall-shared'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { LayoutPresetControls } from './LayoutPresetControls.tsx'

let container: HTMLDivElement | undefined

afterEach(() => {
  if (container) {
    act(() => render(null, container!))
    container.remove()
    container = undefined
  }
})

const presets: LayoutPreset[] = [
  { id: 'p1', name: 'News Wall', cols: 2, rows: 2, views: {} },
  { id: 'p2', name: 'Big Screen', cols: 1, rows: 1, views: {} },
]

function renderControls(
  props: Partial<Parameters<typeof LayoutPresetControls>[0]> = {},
): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    render(
      <LayoutPresetControls
        presets={presets}
        role="operator"
        onSavePreset={vi.fn()}
        onLoadPreset={vi.fn()}
        onDeletePreset={vi.fn()}
        {...props}
      />,
      container!,
    )
  })
  return container
}

function type(input: HTMLInputElement, value: string): void {
  act(() => {
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function submit(form: HTMLFormElement): void {
  act(() => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

describe('LayoutPresetControls', () => {
  test('renders a load button for each saved preset', () => {
    const el = renderControls()
    const buttons = [...el.querySelectorAll('button.preset')].map(
      (b) => b.textContent,
    )
    expect(buttons).toEqual(['News Wall', 'Big Screen'])
  })

  test('calls onLoadPreset with the preset id when a preset button is clicked', () => {
    const onLoadPreset = vi.fn()
    const el = renderControls({ onLoadPreset })
    const button = el.querySelector('button.preset') as HTMLButtonElement

    act(() => button.click())

    expect(onLoadPreset).toHaveBeenCalledWith('p1')
  })

  test('calls onDeletePreset with the preset id when its delete button is clicked', () => {
    const onDeletePreset = vi.fn()
    const el = renderControls({ onDeletePreset })
    const deleteButton = el.querySelector('button.delete') as HTMLButtonElement

    act(() => deleteButton.click())

    expect(onDeletePreset).toHaveBeenCalledWith('p1')
  })

  test('submits the typed name and clears the input on save', () => {
    const onSavePreset = vi.fn()
    const el = renderControls({ onSavePreset })
    const input = el.querySelector('input') as HTMLInputElement
    const form = el.querySelector('form') as HTMLFormElement

    type(input, 'My New Layout')
    submit(form)

    expect(onSavePreset).toHaveBeenCalledWith('My New Layout')
    expect(input.value).toBe('')
  })

  test('does not call onSavePreset for a blank or whitespace-only name', () => {
    const onSavePreset = vi.fn()
    const el = renderControls({ onSavePreset })
    const input = el.querySelector('input') as HTMLInputElement
    const form = el.querySelector('form') as HTMLFormElement

    type(input, '   ')
    submit(form)

    expect(onSavePreset).not.toHaveBeenCalled()
  })

  test('disables all controls for a role without save-layout-preset permission', () => {
    const el = renderControls({ role: 'monitor' })

    const input = el.querySelector('input') as HTMLInputElement
    const saveButton = el.querySelector(
      'button[type="submit"]',
    ) as HTMLButtonElement
    const presetButtons = [...el.querySelectorAll('button.preset')]
    const deleteButtons = [...el.querySelectorAll('button.delete')]

    expect(input.disabled).toBe(true)
    expect(saveButton.disabled).toBe(true)
    for (const button of [...presetButtons, ...deleteButtons]) {
      expect((button as HTMLButtonElement).disabled).toBe(true)
    }
  })

  test('enables all controls for the local role', () => {
    const el = renderControls({ role: 'local' })

    const input = el.querySelector('input') as HTMLInputElement
    const presetButton = el.querySelector('button.preset') as HTMLButtonElement

    expect(input.disabled).toBe(false)
    expect(presetButton.disabled).toBe(false)
  })
})
