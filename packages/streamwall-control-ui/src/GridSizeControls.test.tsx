import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { GridSizeControls } from './GridSizeControls.tsx'

let container: HTMLDivElement | undefined

afterEach(() => {
  if (container) {
    act(() => render(null, container!))
    container.remove()
    container = undefined
  }
})

function renderControls(
  props: Partial<Parameters<typeof GridSizeControls>[0]> = {},
): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    render(
      <GridSizeControls
        cols={3}
        rows={3}
        role="admin"
        onSetGridSize={() => {}}
        {...props}
      />,
      container!,
    )
  })
  return container
}

// Simulate a user typing into the input (React-style onChange fires on input).
function type(input: HTMLInputElement, value: string): void {
  act(() => {
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function pressEnter(input: HTMLInputElement): void {
  act(() => {
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    )
  })
}

// Under preact/compat, onBlur is wired to the (bubbling) focusout event, as in React.
function blur(input: HTMLInputElement): void {
  act(() => {
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  })
}

describe('GridSizeControls presets', () => {
  test('marks the preset matching the current grid size as active', () => {
    const box = renderControls({ cols: 3, rows: 3 })

    const active = box.querySelector('button.preset.active')
    expect(active?.textContent).toBe('3×3')
  })

  test('does not mark any preset active when the current size matches none', () => {
    const box = renderControls({ cols: 5, rows: 7 })

    expect(box.querySelector('button.preset.active')).toBeNull()
  })

  test('requests the preset size when a preset button is clicked', () => {
    const onSetGridSize = vi.fn()
    const box = renderControls({ cols: 3, rows: 3, onSetGridSize })

    const preset = Array.from(box.querySelectorAll('button.preset')).find(
      (button) => button.textContent === '4×3',
    ) as HTMLButtonElement

    act(() => {
      preset.click()
    })

    expect(onSetGridSize).toHaveBeenCalledWith(4, 3)
  })

  test('disables preset buttons for a role that cannot mutate the state doc', () => {
    const box = renderControls({ role: 'monitor' })

    const preset = box.querySelector('button.preset') as HTMLButtonElement
    expect(preset.disabled).toBe(true)
  })
})

describe('GridSizeControls column/row inputs', () => {
  test('reflects the current columns and rows in the input values', () => {
    const box = renderControls({ cols: 4, rows: 6 })

    const [colsInput, rowsInput] = Array.from(
      box.querySelectorAll('input[type="number"]'),
    ) as HTMLInputElement[]

    expect(colsInput.value).toBe('4')
    expect(rowsInput.value).toBe('6')
  })

  test('commits a valid columns value on blur, keeping the current rows', () => {
    const onSetGridSize = vi.fn()
    const box = renderControls({ cols: 3, rows: 5, onSetGridSize })
    const colsInput = box.querySelector(
      'input[type="number"]',
    ) as HTMLInputElement

    type(colsInput, '6')
    blur(colsInput)

    expect(onSetGridSize).toHaveBeenCalledWith(6, 5)
  })

  test('ignores an out-of-range columns value on blur and reverts the draft', () => {
    const onSetGridSize = vi.fn()
    const box = renderControls({ cols: 3, rows: 5, onSetGridSize })
    const colsInput = box.querySelector(
      'input[type="number"]',
    ) as HTMLInputElement

    type(colsInput, '99')
    blur(colsInput)

    expect(onSetGridSize).not.toHaveBeenCalled()
    expect(colsInput.value).toBe('3')
  })

  test('ignores an emptied columns value on blur instead of collapsing the grid', () => {
    const onSetGridSize = vi.fn()
    const box = renderControls({ cols: 3, rows: 5, onSetGridSize })
    const colsInput = box.querySelector(
      'input[type="number"]',
    ) as HTMLInputElement

    type(colsInput, '')
    blur(colsInput)

    expect(onSetGridSize).not.toHaveBeenCalled()
    expect(colsInput.value).toBe('3')
  })

  test('commits the rows input on Enter (which blurs it)', () => {
    const onSetGridSize = vi.fn()
    const box = renderControls({ cols: 3, rows: 5, onSetGridSize })
    const [, rowsInput] = Array.from(
      box.querySelectorAll('input[type="number"]'),
    ) as HTMLInputElement[]

    type(rowsInput, '7')
    pressEnter(rowsInput)
    blur(rowsInput)

    expect(onSetGridSize).toHaveBeenCalledWith(3, 7)
    // Committed exactly once, not double-fired by both Enter and blur.
    expect(onSetGridSize).toHaveBeenCalledTimes(1)
  })

  test('disables the inputs for a role that cannot mutate the state doc', () => {
    const box = renderControls({ role: null })

    const inputs = Array.from(
      box.querySelectorAll('input[type="number"]'),
    ) as HTMLInputElement[]

    expect(inputs.every((input) => input.disabled)).toBe(true)
  })
})
