import { render } from 'preact'
import { act } from 'preact/test-utils'
import { type StreamData } from 'streamwall-shared'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  CreateCustomStreamInput,
  CustomStreamInput,
  StreamList,
} from './Sidebar.tsx'

let container: HTMLDivElement | undefined

afterEach(() => {
  if (container) {
    act(() => render(null, container!))
    container.remove()
    container = undefined
  }
})

function baseRow(overrides: Partial<StreamData> = {}): StreamData {
  return {
    _id: 'abc',
    _dataSource: 'example',
    kind: 'video',
    link: 'https://example.com/stream',
    ...overrides,
  }
}

describe('StreamList', () => {
  test('renders one line per row, labeled by id', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    act(() => {
      render(
        <StreamList
          rows={[baseRow({ _id: 'a' }), baseRow({ _id: 'b' })]}
          disabled={false}
          onClickId={() => {}}
          favorites={new Set()}
        />,
        container!,
      )
    })

    const ids = Array.from(container.querySelectorAll('div')).map(
      (el) => el.textContent,
    )
    expect(ids.some((text) => text?.startsWith('a'))).toBe(true)
    expect(ids.some((text) => text?.startsWith('b'))).toBe(true)
  })

  test('invokes onClickId with the row id on mousedown when not disabled', () => {
    const onClickId = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    act(() => {
      render(
        <StreamList
          rows={[baseRow({ _id: 'xyz' })]}
          disabled={false}
          onClickId={onClickId}
          favorites={new Set()}
        />,
        container!,
      )
    })

    // container > StreamLine's StyledStreamLine wrapper > StyledId badge.
    const idBadge = container.firstElementChild
      ?.firstElementChild as HTMLDivElement
    act(() => {
      idBadge.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })

    expect(onClickId).toHaveBeenCalledWith('xyz')
  })

  test('does not invoke onClickId on mousedown when disabled', () => {
    const onClickId = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    act(() => {
      render(
        <StreamList
          rows={[baseRow({ _id: 'xyz' })]}
          disabled={true}
          onClickId={onClickId}
          favorites={new Set()}
        />,
        container!,
      )
    })

    const idBadge = container.firstElementChild
      ?.firstElementChild as HTMLDivElement
    act(() => {
      idBadge.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })

    expect(onClickId).not.toHaveBeenCalled()
  })

  test('renders the label instead of source/link when a label is set', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    act(() => {
      render(
        <StreamList
          rows={[
            baseRow({
              label: 'My Custom Label',
              source: 'Some Source',
              link: 'https://example.com/should-not-show',
            }),
          ]}
          disabled={false}
          onClickId={() => {}}
          favorites={new Set()}
        />,
        container!,
      )
    })

    expect(container.textContent).toContain('My Custom Label')
    expect(container.textContent).not.toContain('Some Source')
  })

  test('renders source and truncated link when no label is set', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    act(() => {
      render(
        <StreamList
          rows={[baseRow({ source: 'Some Source', city: 'Springfield' })]}
          disabled={false}
          onClickId={() => {}}
          favorites={new Set()}
        />,
        container!,
      )
    })

    expect(container.textContent).toContain('Some Source')
    expect(container.textContent).toContain('Springfield')
  })
})

describe('StreamList favorites', () => {
  test('renders a filled star for a favorited row and an empty star for a non-favorited one', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    act(() => {
      render(
        <StreamList
          rows={[
            baseRow({ _id: 'a', link: 'https://example.com/a' }),
            baseRow({ _id: 'b', link: 'https://example.com/b' }),
          ]}
          disabled={false}
          onClickId={() => {}}
          favorites={new Set(['https://example.com/a'])}
          onToggleFavorite={() => {}}
        />,
        container!,
      )
    })

    const buttons = container.querySelectorAll('button')
    expect(buttons).toHaveLength(2)
    expect(buttons[0].textContent).toBe('★')
    expect(buttons[1].textContent).toBe('☆')
  })

  test('invokes onToggleFavorite with the row link when the star is clicked, without triggering onClickId', () => {
    const onToggleFavorite = vi.fn()
    const onClickId = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    act(() => {
      render(
        <StreamList
          rows={[baseRow({ _id: 'a', link: 'https://example.com/a' })]}
          disabled={false}
          onClickId={onClickId}
          favorites={new Set()}
          onToggleFavorite={onToggleFavorite}
        />,
        container!,
      )
    })

    const button = container.querySelector('button') as HTMLButtonElement
    act(() => {
      button.click()
    })

    expect(onToggleFavorite).toHaveBeenCalledWith('https://example.com/a')
    expect(onClickId).not.toHaveBeenCalled()
  })

  test('hides the favorite star entirely when onToggleFavorite is not provided', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    act(() => {
      render(
        <StreamList
          rows={[baseRow({ _id: 'a' })]}
          disabled={false}
          onClickId={() => {}}
          favorites={new Set()}
        />,
        container!,
      )
    })

    expect(container.querySelector('button')).toBeNull()
  })
})

describe('CustomStreamInput', () => {
  test('commits an edited label merged with the other stream fields', () => {
    const onChange = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    act(() => {
      render(
        <CustomStreamInput
          link="https://example.com/a"
          kind="video"
          label=""
          onChange={onChange}
          onDelete={() => {}}
        />,
        container!,
      )
    })

    const input = container.querySelector('input') as HTMLInputElement
    act(() => {
      input.value = 'new label'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      )
    })

    expect(onChange).toHaveBeenCalledWith('https://example.com/a', {
      link: 'https://example.com/a',
      kind: 'video',
      label: 'new label',
    })
  })

  test('requests deletion of this stream link when the delete button is clicked', () => {
    const onDelete = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    act(() => {
      render(
        <CustomStreamInput
          link="https://example.com/a"
          kind="video"
          label=""
          onChange={() => {}}
          onDelete={onDelete}
        />,
        container!,
      )
    })

    const deleteButton = container.querySelector('button') as HTMLButtonElement
    act(() => {
      deleteButton.click()
    })

    expect(onDelete).toHaveBeenCalledWith('https://example.com/a')
  })
})

describe('CreateCustomStreamInput', () => {
  test('creates a stream from the form fields and resets them', () => {
    const onCreate = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    act(() => {
      render(<CreateCustomStreamInput onCreate={onCreate} />, container!)
    })

    const linkInput = container.querySelector('input') as HTMLInputElement
    const select = container.querySelector('select') as HTMLSelectElement
    const labelInput = container.querySelectorAll(
      'input',
    )[1] as HTMLInputElement
    const form = container.querySelector('form') as HTMLFormElement

    act(() => {
      linkInput.value = 'https://example.com/new'
      linkInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      select.value = 'audio'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    act(() => {
      labelInput.value = 'New stream'
      labelInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      form.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })

    expect(onCreate).toHaveBeenCalledWith('https://example.com/new', {
      link: 'https://example.com/new',
      kind: 'audio',
      label: 'New stream',
    })
    expect(linkInput.value).toBe('')
    expect(labelInput.value).toBe('')
  })
})
