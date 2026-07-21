import { render } from 'preact'
import { act } from 'preact/test-utils'
import { Color } from 'streamwall-shared'
import { afterEach, describe, expect, test } from 'vitest'
import { GridPreviewBox } from './GridPreviewBox.tsx'

let container: HTMLDivElement | undefined

afterEach(() => {
  if (container) {
    act(() => render(null, container!))
    container.remove()
    container = undefined
  }
})

function renderBox(
  props: Partial<Parameters<typeof GridPreviewBox>[0]> = {},
): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    render(
      <GridPreviewBox
        streamId="abc"
        color={Color('red')}
        pos={{ x: 0, y: 0, width: 100, height: 100, spaces: [0] }}
        windowWidth={100}
        windowHeight={100}
        isListening={false}
        isSmall={false}
        isError={false}
        errorReason={null}
        isPaused={false}
        orientation={null}
        source="Example Source"
        city={undefined}
        state={undefined}
        {...props}
      />,
      container!,
    )
  })
  return container
}

describe('GridPreviewBox', () => {
  test('renders the error badge with the reason when the view is errored', () => {
    const box = renderBox({
      isError: true,
      errorReason: 'Connection lost',
    })

    const badge = box.querySelector('svg')?.parentElement
    expect(badge?.tagName).toBe('DIV')
    expect(badge?.textContent).toContain('Connection lost')
    expect(badge?.getAttribute('title')).toBe('Connection lost')
  })

  test('falls back to a generic label when the errored view has no reason', () => {
    const box = renderBox({
      isError: true,
      errorReason: null,
    })

    const badge = box.querySelector('svg')?.parentElement
    expect(badge?.textContent).toContain('Stream error')
    expect(badge?.hasAttribute('title')).toBe(false)
  })

  test('does not render the error badge for a non-error view', () => {
    const box = renderBox({ isError: false })

    expect(box.querySelector('svg')).toBeNull()
  })

  test('renders the paused badge for a parked view whose playback is paused (#490)', () => {
    const box = renderBox({ isPaused: true })

    const badge = box.querySelector('[data-testid="grid-paused-badge"]')
    expect(badge).not.toBeNull()
    expect(badge!.textContent).toContain('Paused')
    expect(badge!.querySelector('svg')).not.toBeNull()
  })

  test('does not render the paused badge for a playing view (#490)', () => {
    const box = renderBox({ isPaused: false })

    expect(box.querySelector('[data-testid="grid-paused-badge"]')).toBeNull()
  })

  test('marks the info panel as small so the reason text collapses on small cells', () => {
    const box = renderBox({ isSmall: true })

    expect(box.querySelector('.small')).not.toBeNull()
  })

  test('does not leak custom styled-component props onto the DOM node (#152)', () => {
    const box = renderBox({ isError: true, isListening: true, isPaused: true })

    for (const el of box.querySelectorAll('*')) {
      for (const propName of [
        'color',
        'pos',
        'windowwidth',
        'windowheight',
        'islistening',
        'iserror',
        'ispaused',
      ]) {
        expect(
          el.hasAttribute(propName),
          `<${el.tagName.toLowerCase()}> unexpectedly has a "${propName}" attribute`,
        ).toBe(false)
      }
    }
  })

  test('shows the assigned audio hotkey as a tooltip for a cell within the hotkey range (#84)', () => {
    const box = renderBox({
      pos: { x: 0, y: 0, width: 100, height: 100, spaces: [0] },
    })

    expect(box.firstElementChild?.getAttribute('title')).toBe(
      'Alt+1 toggles audio',
    )
  })

  test('surfaces the correct key for a later cell within the hotkey range (#84)', () => {
    const box = renderBox({
      pos: { x: 0, y: 0, width: 100, height: 100, spaces: [10] },
    })

    expect(box.firstElementChild?.getAttribute('title')).toBe(
      'Alt+Q toggles audio',
    )
  })

  test('surfaces the chorded hotkey for a cell in the second (alt+ctrl) layer (#240)', () => {
    const box = renderBox({
      pos: { x: 0, y: 0, width: 100, height: 100, spaces: [20] },
    })

    expect(box.firstElementChild?.getAttribute('title')).toBe(
      'Alt+Ctrl+1 toggles audio',
    )
  })

  test('omits the hotkey tooltip for a cell beyond both hotkey layers (#240)', () => {
    const box = renderBox({
      pos: { x: 0, y: 0, width: 100, height: 100, spaces: [40] },
    })

    expect(box.firstElementChild?.hasAttribute('title')).toBe(false)
  })
})
