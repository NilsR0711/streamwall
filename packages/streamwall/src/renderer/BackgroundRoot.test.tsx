// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import type { StreamData } from 'streamwall-shared'
import { afterEach, describe, expect, test } from 'vitest'
import { Background } from './BackgroundRoot'

let container: HTMLDivElement | undefined

afterEach(() => {
  if (container) {
    act(() => render(null, container!))
    container.remove()
    container = undefined
  }
})

function makeBackground(link: string): StreamData {
  return {
    _id: link,
    _dataSource: 'custom',
    kind: 'background',
    link,
  }
}

function renderBackground(
  streams: StreamData[],
  blockedURLs?: readonly string[],
): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    render(
      <Background streams={streams} blockedURLs={blockedURLs} />,
      container!,
    )
  })
  return container
}

describe('Background blocked-URL rendering', () => {
  test('frames each background and says nothing while none was refused', () => {
    const root = renderBackground([makeBackground('https://ok.example/bg')])

    expect(root.querySelector('iframe')?.getAttribute('src')).toBe(
      'https://ok.example/bg',
    )
    expect(root.querySelector('[role="alert"]')).toBeNull()
  })

  test('names a refused URL on the wall', () => {
    const root = renderBackground(
      [makeBackground('http://192.168.1.50/bg')],
      ['http://192.168.1.50/bg'],
    )

    expect(root.textContent).toContain('http://192.168.1.50/bg')
    expect(root.textContent).toContain('not a public address')
  })

  test('leaves every frame mounted, so a URL refused once can still succeed', () => {
    // The guard reports the request it cancelled, which for a redirected link
    // or a refused sub-resource is not the URL the operator typed -- so the
    // notice never decides which frame to take down.
    const root = renderBackground(
      [
        makeBackground('http://192.168.1.50/bg'),
        makeBackground('https://ok.example/bg'),
      ],
      ['http://192.168.1.50/bg'],
    )

    expect(
      [...root.querySelectorAll('iframe')].map((frame) =>
        frame.getAttribute('src'),
      ),
    ).toEqual(['http://192.168.1.50/bg', 'https://ok.example/bg'])
  })
})
