// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { FaExclamationTriangle } from 'react-icons/fa'
import styled from 'styled-components'
import { afterEach, describe, expect, test } from 'vitest'

// Regression test for https://github.com/NilsR0711/streamwall/issues/177:
// react-icons and styled-components must resolve `react` to `preact/compat`
// (see vitest.config.ts) rather than the real `react` package that npm
// installs as their peer dependency, or rendering either throws / produces
// the wrong DOM tag.

const Box = styled.div`
  color: red;
`

let container: HTMLDivElement | undefined

afterEach(() => {
  if (container) {
    act(() => render(null, container!))
    container.remove()
    container = undefined
  }
})

function mount(vnode: preact.ComponentChild) {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => render(vnode, container!))
  return container
}

describe('preact/compat interop', () => {
  test('renders a react-icons icon as a real svg', () => {
    const tile = mount(<FaExclamationTriangle />)
    expect(tile.querySelector('svg')).not.toBeNull()
  })

  test('renders a styled-components element with its real DOM tag', () => {
    const tile = mount(<Box />)
    expect(tile.firstElementChild?.tagName).toBe('DIV')
  })
})
