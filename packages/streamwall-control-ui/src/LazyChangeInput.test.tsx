import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { LazyChangeInput } from './LazyChangeInput.tsx'

let container: HTMLDivElement | undefined

afterEach(() => {
  if (container) {
    act(() => render(null, container!))
    container.remove()
    container = undefined
  }
})

function renderInput(
  props: Parameters<typeof LazyChangeInput>[0],
): HTMLInputElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    render(<LazyChangeInput {...props} />, container!)
  })
  const input = container.querySelector('input')
  if (!input) {
    throw new Error('expected an input element to be rendered')
  }
  return input
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

describe('LazyChangeInput', () => {
  test('commits the edit when Enter is pressed in a non-eager input', () => {
    const onChange = vi.fn()
    const input = renderInput({ value: 'old', onChange })

    type(input, 'new')
    pressEnter(input)

    expect(onChange).toHaveBeenCalledWith('new')
  })

  test('does not lose the edit when Enter is followed by a real blur', () => {
    const onChange = vi.fn()
    const input = renderInput({ value: 'old', onChange })

    type(input, 'new')
    pressEnter(input)
    blur(input)

    expect(onChange).toHaveBeenCalledWith('new')
    // The value is committed exactly once, not dropped and not double-fired.
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  test('commits the edit on blur in a non-eager input', () => {
    const onChange = vi.fn()
    const input = renderInput({ value: 'old', onChange })

    type(input, 'edited')
    blur(input)

    expect(onChange).toHaveBeenCalledWith('edited')
  })

  test('commits to the latest onChange handler after a re-render', () => {
    const firstOnChange = vi.fn()
    const secondOnChange = vi.fn()
    const input = renderInput({ value: 'old', onChange: firstOnChange })

    type(input, 'new')
    // Parent re-renders with a fresh onChange identity (a common React pattern).
    act(() => {
      render(
        <LazyChangeInput value="old" onChange={secondOnChange} />,
        container!,
      )
    })
    pressEnter(input)

    expect(secondOnChange).toHaveBeenCalledWith('new')
    expect(firstOnChange).not.toHaveBeenCalled()
  })

  test('fires onChange on every keystroke when eager', () => {
    const onChange = vi.fn()
    const input = renderInput({ value: '', isEager: true, onChange })

    type(input, 'a')
    type(input, 'ab')

    expect(onChange).toHaveBeenNthCalledWith(1, 'a')
    expect(onChange).toHaveBeenNthCalledWith(2, 'ab')
    // Enter must not commit a second time in eager mode.
    pressEnter(input)
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  // GridInput passes its own onFocus/onBlur (to track focusedInputIdx). Those
  // must be composed with, not replace, the internal handlers - otherwise
  // editingValue is never seeded/cleared and a stale edit lingers forever
  // (issue #744).
  describe('when the caller supplies its own onFocus/onBlur', () => {
    test('still seeds and commits the edit, and still calls the caller handlers', () => {
      const onChange = vi.fn()
      const callerOnFocus = vi.fn()
      const callerOnBlur = vi.fn()
      const input = renderInput({
        value: 'old',
        onChange,
        onFocus: callerOnFocus,
        onBlur: callerOnBlur,
      })

      // Under preact/compat, onFocus is wired to the (bubbling) focusin
      // event, mirroring onBlur/focusout.
      act(() => {
        input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
      })
      expect(callerOnFocus).toHaveBeenCalledTimes(1)

      type(input, 'new')
      blur(input)

      expect(callerOnBlur).toHaveBeenCalledTimes(1)
      expect(onChange).toHaveBeenCalledWith('new')
    })

    test('still clears editingValue on blur, so a later prop update is not masked by the stale edit', () => {
      const onChange = vi.fn()
      const input = renderInput({
        value: 'old',
        onChange,
        onFocus: vi.fn(),
        onBlur: vi.fn(),
      })

      type(input, 'zzz')
      blur(input)

      // Re-render with a fresh value, as a parent does after committing
      // elsewhere (e.g. a drag/swap calling activeElement.blur()).
      act(() => {
        render(
          <LazyChangeInput
            value="fresh"
            onChange={onChange}
            onFocus={vi.fn()}
            onBlur={vi.fn()}
          />,
          container!,
        )
      })

      expect(input.value).toBe('fresh')
    })
  })
})
