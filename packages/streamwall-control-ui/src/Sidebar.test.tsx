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

describe('StreamList keyboard path', () => {
  function renderHandle({
    disabled = false,
    onClickId = () => {},
  }: {
    disabled?: boolean
    onClickId?: (id: string) => void
  }): HTMLButtonElement {
    container = document.createElement('div')
    document.body.appendChild(container)
    act(() => {
      render(
        <StreamList
          rows={[baseRow({ _id: 'xyz' })]}
          disabled={disabled}
          onClickId={onClickId}
          favorites={new Set()}
        />,
        container!,
      )
    })
    return container.querySelector<HTMLButtonElement>(
      '[aria-label="Add stream xyz to the wall"]',
    )!
  }

  test('renders the id/drag handle as a focusable button', () => {
    const handle = renderHandle({})

    expect(handle.tagName).toBe('BUTTON')
    expect(handle.type).toBe('button')
    expect(handle.disabled).toBe(false)
    expect(handle.getAttribute('tabindex')).not.toBe('-1')
  })

  test('marks the handle disabled so it drops out of the tab order', () => {
    const handle = renderHandle({ disabled: true })

    expect(handle.disabled).toBe(true)
  })

  for (const key of ['Enter', ' ']) {
    test(`invokes onClickId when activated with ${key === ' ' ? 'Space' : key}`, () => {
      const onClickId = vi.fn()
      const handle = renderHandle({ onClickId })

      const event = new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
      })
      act(() => {
        handle.dispatchEvent(event)
      })

      expect(onClickId).toHaveBeenCalledWith('xyz')
      // Suppress the browser's synthetic click so activation happens once.
      expect(event.defaultPrevented).toBe(true)
    })
  }

  test('ignores other keys', () => {
    const onClickId = vi.fn()
    const handle = renderHandle({ onClickId })

    act(() => {
      handle.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'a', bubbles: true }),
      )
    })

    expect(onClickId).not.toHaveBeenCalled()
  })

  test('does not invoke onClickId on keydown when disabled', () => {
    const onClickId = vi.fn()
    const handle = renderHandle({ disabled: true, onClickId })

    act(() => {
      handle.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      )
    })

    expect(onClickId).not.toHaveBeenCalled()
  })

  test('prevents the default mousedown focus shift so a destination grid input stays focused', () => {
    const onClickId = vi.fn()
    const handle = renderHandle({ onClickId })

    const event = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
    })
    act(() => {
      handle.dispatchEvent(event)
    })

    expect(onClickId).toHaveBeenCalledWith('xyz')
    expect(event.defaultPrevented).toBe(true)
  })

  test('activates only once for a full mouse press-and-release', () => {
    const onClickId = vi.fn()
    const handle = renderHandle({ onClickId })

    act(() => {
      handle.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
      )
      handle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onClickId).toHaveBeenCalledTimes(1)
  })
})

describe('StreamList accessible names', () => {
  test('gives the id/drag handle a descriptive accessible name', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    act(() => {
      render(
        <StreamList
          rows={[baseRow({ _id: 'xyz' })]}
          disabled={false}
          onClickId={() => {}}
          favorites={new Set()}
        />,
        container!,
      )
    })

    expect(
      container.querySelector('[aria-label="Add stream xyz to the wall"]'),
    ).not.toBeNull()
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

    const stars = container.querySelectorAll('button.favorite-star')
    expect(stars).toHaveLength(2)
    expect(stars[0].textContent).toBe('★')
    expect(stars[1].textContent).toBe('☆')
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

    const star = container.querySelector(
      'button.favorite-star',
    ) as HTMLButtonElement
    act(() => {
      star.click()
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

    expect(container.querySelector('button.favorite-star')).toBeNull()
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

describe('CustomStreamInput accessible names', () => {
  test('labels the editable label field and the delete button by the stream name', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    act(() => {
      render(
        <CustomStreamInput
          link="https://example.com/a"
          kind="video"
          label="Corner cam"
          onChange={() => {}}
          onDelete={() => {}}
        />,
        container!,
      )
    })

    expect(
      container.querySelector('input[aria-label="Custom stream label"]'),
    ).not.toBeNull()
    expect(
      container.querySelector(
        'button[aria-label="Delete custom stream Corner cam"]',
      ),
    ).not.toBeNull()
  })

  test('falls back to the link when the stream has no label', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    act(() => {
      render(
        <CustomStreamInput
          link="https://example.com/a"
          kind="video"
          label=""
          onChange={() => {}}
          onDelete={() => {}}
        />,
        container!,
      )
    })

    expect(
      container.querySelector(
        'button[aria-label="Delete custom stream https://example.com/a"]',
      ),
    ).not.toBeNull()
  })
})

describe('CreateCustomStreamInput', () => {
  test('gives the url, type and label fields programmatic names', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    act(() => {
      render(<CreateCustomStreamInput onCreate={() => {}} />, container!)
    })

    expect(
      container.querySelector('input[aria-label="Stream URL"]'),
    ).not.toBeNull()
    expect(
      container.querySelector('select[aria-label="Stream type"]'),
    ).not.toBeNull()
    expect(
      container.querySelector('input[aria-label="Stream label"]'),
    ).not.toBeNull()
  })

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
