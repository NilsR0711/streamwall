// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, test } from 'vitest'
import { BlockedLayerNotice } from './BlockedLayerNotice'

let container: HTMLDivElement | undefined

afterEach(() => {
  if (container) {
    act(() => render(null, container!))
    container.remove()
    container = undefined
  }
})

function renderNotice(url: string, reason: string): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    render(<BlockedLayerNotice url={url} reason={reason} />, container!)
  })
  return container
}

describe('BlockedLayerNotice', () => {
  test('names the URL that was refused and why', () => {
    const root = renderNotice(
      'http://192.168.1.50/overlay',
      'blocking request to private-network address',
    )

    expect(root.textContent).toContain('http://192.168.1.50/overlay')
    expect(root.textContent).toContain(
      'blocking request to private-network address',
    )
  })

  test('is announced as an alert, so it is not just decoration', () => {
    const root = renderNotice('http://192.168.1.50/overlay', 'private network')

    expect(root.querySelector('[role="alert"]')).not.toBeNull()
  })
})
