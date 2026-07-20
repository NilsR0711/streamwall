import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, test } from 'vitest'
import { ServerVersionLabel } from './ServerVersionLabel.tsx'

let container: HTMLDivElement | undefined

afterEach(() => {
  if (container) {
    act(() => render(null, container!))
    container.remove()
    container = undefined
  }
})

function renderLabel(version: string | null): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    render(<ServerVersionLabel version={version} />, container!)
  })
  return container
}

describe('ServerVersionLabel', () => {
  test('renders nothing when there is no version to show', () => {
    const el = renderLabel(null)
    expect(el.querySelector('.server-version-label')).toBeNull()
  })

  test('shows the running server version', () => {
    const el = renderLabel('0.9.1')
    expect(el.querySelector('.server-version-label')?.textContent).toContain(
      '0.9.1',
    )
  })
})
