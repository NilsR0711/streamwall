import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AuthTokenLine, CreateInviteInput } from './AccessPanel.tsx'

let container: HTMLDivElement | undefined

afterEach(() => {
  if (container) {
    act(() => render(null, container!))
    container.remove()
    container = undefined
  }
})

describe('CreateInviteInput', () => {
  test('creates an invite from the form fields, defaulting to the operator role', () => {
    const onCreateInvite = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    act(() => {
      render(<CreateInviteInput onCreateInvite={onCreateInvite} />, container!)
    })

    const nameInput = container.querySelector('input') as HTMLInputElement
    const form = container.querySelector('form') as HTMLFormElement

    act(() => {
      nameInput.value = 'Alex'
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      form.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })

    expect(onCreateInvite).toHaveBeenCalledWith({
      name: 'Alex',
      role: 'operator',
    })
  })

  test('creates an invite with the selected role and resets the form', () => {
    const onCreateInvite = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    act(() => {
      render(<CreateInviteInput onCreateInvite={onCreateInvite} />, container!)
    })

    const nameInput = container.querySelector('input') as HTMLInputElement
    const select = container.querySelector('select') as HTMLSelectElement
    const form = container.querySelector('form') as HTMLFormElement

    act(() => {
      nameInput.value = 'Sam'
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      select.value = 'admin'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    act(() => {
      form.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })

    expect(onCreateInvite).toHaveBeenCalledWith({ name: 'Sam', role: 'admin' })
    expect(nameInput.value).toBe('')
    expect(select.value).toBe('operator')
  })

  test('only offers invitable roles, excluding the local role reserved for the app itself', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    act(() => {
      render(<CreateInviteInput onCreateInvite={() => {}} />, container!)
    })

    const options = Array.from(
      container.querySelectorAll('option'),
      (option) => (option as HTMLOptionElement).value,
    )

    expect(options).toEqual(['admin', 'operator', 'monitor'])
  })

  test('does not create an invite if the role somehow desyncs from the invitable options', () => {
    const onCreateInvite = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    act(() => {
      render(<CreateInviteInput onCreateInvite={onCreateInvite} />, container!)
    })

    const nameInput = container.querySelector('input') as HTMLInputElement
    const select = container.querySelector('select') as HTMLSelectElement
    const form = container.querySelector('form') as HTMLFormElement

    act(() => {
      nameInput.value = 'Jamie'
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      // Not one of the rendered <option>s, so the browser resets the
      // select's value to the empty string rather than accepting it.
      select.value = 'local'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    act(() => {
      form.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })

    expect(onCreateInvite).not.toHaveBeenCalled()
  })
})

describe('CreateInviteInput accessible names', () => {
  test('gives the name field and role select programmatic names', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    act(() => {
      render(<CreateInviteInput onCreateInvite={() => {}} />, container!)
    })

    expect(
      container.querySelector('input[aria-label="Invite name"]'),
    ).not.toBeNull()
    expect(
      container.querySelector('select[aria-label="Invite role"]'),
    ).not.toBeNull()
  })
})

describe('AuthTokenLine', () => {
  test('shows the token name and role', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    act(() => {
      render(
        <AuthTokenLine
          id="token-1"
          name="Alex"
          role="operator"
          onDelete={() => {}}
        />,
        container!,
      )
    })

    expect(container.textContent).toContain('Alex')
    expect(container.textContent).toContain('operator')
  })

  test('requests revocation of this token id when revoke is clicked', () => {
    const onDelete = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    act(() => {
      render(
        <AuthTokenLine
          id="token-1"
          name="Alex"
          role="operator"
          onDelete={onDelete}
        />,
        container!,
      )
    })

    const button = container.querySelector('button') as HTMLButtonElement
    act(() => {
      button.click()
    })

    expect(onDelete).toHaveBeenCalledWith('token-1')
  })
})
