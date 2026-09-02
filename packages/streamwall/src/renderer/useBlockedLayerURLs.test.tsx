// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { MAX_BLOCKED_URLS, useBlockedLayerURLs } from './useBlockedLayerURLs'

let container: HTMLDivElement | undefined

afterEach(() => {
  if (container) {
    act(() => render(null, container!))
    container.remove()
    container = undefined
  }
})

// Renders the hook's list as one line per URL, so a test can read it back out,
// and counts renders so the de-duplication can be observed.
function renderHook(subscribe: Parameters<typeof useBlockedLayerURLs>[0]) {
  let renders = 0
  function Probe() {
    renders++
    const blocked = useBlockedLayerURLs(subscribe)
    return (
      <ul>
        {blocked.map((url) => (
          <li key={url}>{url}</li>
        ))}
      </ul>
    )
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    render(<Probe />, container!)
  })
  return {
    urls: () =>
      [...container!.querySelectorAll('li')].map((li) => li.textContent),
    renders: () => renders,
  }
}

/** Renders the hook and hands back the reporter the subscription captured. */
function renderHookWithReporter() {
  let report: ((url: string) => void) | undefined
  const probe = renderHook((handleBlocked) => {
    report = handleBlocked
    return () => {}
  })
  return { ...probe, report: (url: string) => act(() => report!(url)) }
}

describe('useBlockedLayerURLs', () => {
  test('starts empty and collects each reported URL in order', () => {
    const { urls, report } = renderHookWithReporter()

    expect(urls()).toEqual([])

    report('http://192.168.1.50/a')
    report('http://169.254.169.254/b')

    expect(urls()).toEqual([
      'http://192.168.1.50/a',
      'http://169.254.169.254/b',
    ])
  })

  test('does not re-render when a URL is refused again', () => {
    // A page inside a layer can retry a refused endpoint indefinitely.
    const { urls, renders, report } = renderHookWithReporter()
    report('http://192.168.1.50/a')
    const rendersAfterFirst = renders()

    report('http://192.168.1.50/a')

    expect(urls()).toEqual(['http://192.168.1.50/a'])
    expect(renders()).toBe(rendersAfterFirst)
  })

  test('keeps only the most recent URLs, so a polling page cannot grow it without bound', () => {
    const { urls, report } = renderHookWithReporter()

    for (let i = 0; i < MAX_BLOCKED_URLS + 3; i++) {
      report(`http://192.168.1.50/?t=${i}`)
    }

    expect(urls()).toHaveLength(MAX_BLOCKED_URLS)
    expect(urls()[0]).toBe('http://192.168.1.50/?t=3')
    expect(urls().at(-1)).toBe(`http://192.168.1.50/?t=${MAX_BLOCKED_URLS + 2}`)
  })

  test('unsubscribes when the layer unmounts', () => {
    const unsubscribe = vi.fn()
    renderHook(() => unsubscribe)

    act(() => render(null, container!))

    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
