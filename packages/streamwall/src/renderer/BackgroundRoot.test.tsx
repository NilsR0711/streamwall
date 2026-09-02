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
  blockedURLs?: ReadonlyMap<string, string>,
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
  test('frames a background whose URL the session accepted', () => {
    const root = renderBackground([makeBackground('https://ok.example/bg')])

    const frame = root.querySelector('iframe')
    expect(frame?.getAttribute('src')).toBe('https://ok.example/bg')
  })

  test('replaces a blocked background with a notice naming the URL and reason', () => {
    const root = renderBackground(
      [makeBackground('http://192.168.1.50/bg')],
      new Map([
        [
          'http://192.168.1.50/bg',
          'blocking request to private-network address',
        ],
      ]),
    )

    expect(root.querySelector('iframe')).toBeNull()
    expect(root.textContent).toContain('http://192.168.1.50/bg')
    expect(root.textContent).toContain(
      'blocking request to private-network address',
    )
  })

  test('leaves the other backgrounds framed when only one is blocked', () => {
    const root = renderBackground(
      [
        makeBackground('http://192.168.1.50/bg'),
        makeBackground('https://ok.example/bg'),
      ],
      new Map([['http://192.168.1.50/bg', 'private network']]),
    )

    const frames = [...root.querySelectorAll('iframe')].map((frame) =>
      frame.getAttribute('src'),
    )
    expect(frames).toEqual(['https://ok.example/bg'])
  })

  test('ignores a blocked URL that belongs to no background', () => {
    const root = renderBackground(
      [makeBackground('https://ok.example/bg')],
      new Map([['http://192.168.1.50/somewhere-else', 'private network']]),
    )

    expect(root.querySelector('iframe')).not.toBeNull()
    expect(root.textContent).not.toContain('192.168.1.50')
  })
})
