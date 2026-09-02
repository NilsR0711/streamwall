// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import type { StreamData } from 'streamwall-shared'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  BLOCKED_URL_FLUSH_MS,
  layerLinksKey,
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
// `resetKey` is passed positionally rather than defaulted: `undefined` is a
// meaningful value here (no state yet), which a default parameter would swallow.
function renderHook(
  subscribe: Parameters<typeof useBlockedLayerURLs>[0],
  resetKey: string | undefined,
) {
  let renders = 0
  function Probe({ resetKey: key }: { resetKey: string | undefined }) {
    renders++
    const blocked = useBlockedLayerURLs(subscribe, key)
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
    render(<Probe resetKey={resetKey} />, container!)
  })
  return {
    urls: () =>
      [...container!.querySelectorAll('li')].map((li) => li.textContent),
    renders: () => renders,
    setResetKey: (key: string | undefined) =>
      act(() => {
        render(<Probe resetKey={key} />, container!)
      }),
  }
}

/** Renders the hook and hands back the reporter the subscription captured. */
function renderHookWithReporter(resetKey: string | undefined = 'links') {
  let report: ((url: string) => void) | undefined
  const probe = renderHook((handleBlocked) => {
    report = handleBlocked
    return () => {}
  }, resetKey)
  return {
    ...probe,
    report: (url: string) => report!(url),
    /** Advances past the next flush, so buffered reports reach the render. */
    flush: () =>
      act(() => {
        vi.advanceTimersByTime(BLOCKED_URL_FLUSH_MS)
      }),
  }
}

/** Renders the hook before any state has arrived, so `resetKey` is undefined. */
function renderHookNoState() {
  let report: ((url: string) => void) | undefined
  const probe = renderHook((handleBlocked) => {
    report = handleBlocked
    return () => {}
  }, undefined)
  return {
    ...probe,
    report: (url: string) => report!(url),
    flush: () =>
      act(() => {
        vi.advanceTimersByTime(BLOCKED_URL_FLUSH_MS)
      }),
  }
}

describe('layerLinksKey', () => {
  const stream = (kind: StreamData['kind'], link: string): StreamData => ({
    _id: link,
    _dataSource: 'custom',
    kind,
    link,
  })

  test('covers both layers and ignores everything else', () => {
    const key = layerLinksKey([
      stream('overlay', 'https://a.example'),
      stream('video', 'https://ignored.example'),
      stream('background', 'https://b.example'),
    ])

    expect(key).toContain('https://a.example')
    expect(key).toContain('https://b.example')
    expect(key).not.toContain('ignored')
  })

  test('changes when a layer link is edited', () => {
    expect(layerLinksKey([stream('overlay', 'https://a.example')])).not.toBe(
      layerLinksKey([stream('overlay', 'https://b.example')]),
    )
  })
})

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

  test('keeps the URLs it already has rather than letting layer content push them out', () => {
    // A framed page can request any number of distinct refused URLs; the
    // operator's own refused link must not be evicted by that churn.
    const { urls, report, flush } = renderHookWithReporter()
    report('http://192.168.1.50/the-operators-link')
    flush()

    for (let i = 0; i < MAX_BLOCKED_URLS * 10; i++) {
      report(`http://192.168.1.50/?churn=${i}`)
    }
    flush()

    expect(urls()).toHaveLength(MAX_BLOCKED_URLS)
    expect(urls()[0]).toBe('http://192.168.1.50/the-operators-link')
  })

  test('clears when the layer links change, so a fixed address stops being reported', () => {
    // A refused iframe is requested exactly once, so a report can never expire
    // on its own evidence, and the layer page is never reloaded on a config
    // change -- the operator's edit is the only signal there is.
    const { urls, report, flush, setResetKey } = renderHookWithReporter()
    report('http://192.168.1.50/a')
    flush()
    expect(urls()).toEqual(['http://192.168.1.50/a'])

    setResetKey('https://fixed.example')
    flush()

    expect(urls()).toEqual([])
  })

  test('keeps reports made before the first state arrives', () => {
    // The main process replays what it refused while the overlay renderer was
    // still loading, and that replay lands before the first state message -- so
    // learning the links for the first time must not throw it away.
    const { urls, report, flush, setResetKey } = renderHookNoState()

    report('http://192.168.1.50/a')
    setResetKey('https://the.example/overlay')
    flush()

    expect(urls()).toEqual(['http://192.168.1.50/a'])
  })

  test('keeps the notice while the operator has changed nothing', () => {
    const { urls, report, flush } = renderHookWithReporter()
    report('http://192.168.1.50/a')

    for (let i = 0; i < 10; i++) {
      flush()
    }

    expect(urls()).toEqual(['http://192.168.1.50/a'])
  })

  test('unsubscribes and stops its timer when the layer unmounts', () => {
    const unsubscribe = vi.fn()
    renderHook(() => unsubscribe, 'links')

    act(() => render(null, container!))

    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
