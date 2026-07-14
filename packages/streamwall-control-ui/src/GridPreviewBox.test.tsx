import Color from 'color'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, test } from 'vitest'
import { GridPreviewBox } from './index.tsx'

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

  test('marks the info panel as small so the reason text collapses on small cells', () => {
    const box = renderBox({ isSmall: true })

    expect(box.querySelector('.small')).not.toBeNull()
  })
})
