// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  BLOCKED_URL_FLUSH_MS,
  BLOCKED_URL_TTL_MS,
  MAX_BLOCKED_URLS,
  useBlockedLayerURLs,
} from './useBlockedLayerURLs'

let container: HTMLDivElement | undefined

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  if (container) {
    act(() => render(null, container!))
    container.remove()
    container = undefined
  }
  vi.useRealTimers()
})

// Renders the hook's list as one line per URL so a test can read it back out,
// and counts renders so the report coalescing can be observed.
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
  return {
    ...probe,
    report: (url: string) => report!(url),
    /** Advances past the next flush, so buffered reports reach the render. */
    flush: (times = 1) =>
      act(() => {
        vi.advanceTimersByTime(BLOCKED_URL_FLUSH_MS * times)
      }),
  }
}

describe('useBlockedLayerURLs', () => {
  test('starts empty and collects each reported URL in order', () => {
    const { urls, report, flush } = renderHookWithReporter()

    expect(urls()).toEqual([])

    report('http://192.168.1.50/a')
    report('http://169.254.169.254/b')
    flush()

    expect(urls()).toEqual([
      'http://192.168.1.50/a',
      'http://169.254.169.254/b',
    ])
  })

  test('does not render a report until the next flush', () => {
    // A framed page can poll a refused endpoint at request rate; rendering each
    // report as it arrived would re-render the whole wall just as often.
    const { urls, renders, report } = renderHookWithReporter()
    const rendersBefore = renders()

    for (let i = 0; i < 20; i++) {
      report(`http://192.168.1.50/?t=${i}`)
    }

    expect(urls()).toEqual([])
    expect(renders()).toBe(rendersBefore)
  })

  test('keeps only the most recent URLs, so a polling page cannot fill the wall', () => {
    const { urls, report, flush } = renderHookWithReporter()

    for (let i = 0; i < MAX_BLOCKED_URLS + 3; i++) {
      report(`http://192.168.1.50/?t=${i}`)
    }
    flush()

    expect(urls()).toHaveLength(MAX_BLOCKED_URLS)
    expect(urls().at(-1)).toBe(`http://192.168.1.50/?t=${MAX_BLOCKED_URLS + 2}`)
  })

  test('does not re-render when the same URL is refused again', () => {
    const { urls, renders, report, flush } = renderHookWithReporter()
    report('http://192.168.1.50/a')
    flush()
    const rendersAfterFirst = renders()

    report('http://192.168.1.50/a')
    flush()

    expect(urls()).toEqual(['http://192.168.1.50/a'])
    expect(renders()).toBe(rendersAfterFirst)
  })

  test('drops a URL once it has stopped being refused, so a fixed link clears', () => {
    // The layer page is never reloaded on a config change, so nothing else
    // would ever take the notice down again.
    const { urls, report, flush } = renderHookWithReporter()
    report('http://192.168.1.50/a')
    flush()
    expect(urls()).toEqual(['http://192.168.1.50/a'])

    flush(BLOCKED_URL_TTL_MS / BLOCKED_URL_FLUSH_MS + 1)

    expect(urls()).toEqual([])
  })

  test('keeps a URL that is still being refused', () => {
    const { urls, report, flush } = renderHookWithReporter()

    for (let i = 0; i < BLOCKED_URL_TTL_MS / BLOCKED_URL_FLUSH_MS + 2; i++) {
      report('http://192.168.1.50/a')
      flush()
    }

    expect(urls()).toEqual(['http://192.168.1.50/a'])
  })

  test('unsubscribes and stops its timer when the layer unmounts', () => {
    const unsubscribe = vi.fn()
    renderHook(() => unsubscribe)

    act(() => render(null, container!))

    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
