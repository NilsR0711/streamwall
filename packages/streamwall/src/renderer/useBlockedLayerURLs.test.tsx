// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { BlockedLayerURL } from '../preload/layerPreload'
import { useBlockedLayerURLs } from './useBlockedLayerURLs'

let container: HTMLDivElement | undefined

afterEach(() => {
  if (container) {
    act(() => render(null, container!))
    container.remove()
    container = undefined
  }
})

// Renders the hook's map as one line per entry, so a test can read it back out.
function renderHook(subscribe: Parameters<typeof useBlockedLayerURLs>[0]) {
  function Probe() {
    const blocked = useBlockedLayerURLs(subscribe)
    return (
      <ul>
        {[...blocked].map(([url, reason]) => (
          <li key={url}>{`${url} :: ${reason}`}</li>
        ))}
      </ul>
    )
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    render(<Probe />, container!)
  })
  return () =>
    [...container!.querySelectorAll('li')].map((li) => li.textContent)
}

describe('useBlockedLayerURLs', () => {
  test('starts empty and collects each reported URL', () => {
    let report: ((blocked: BlockedLayerURL) => void) | undefined
    const entries = renderHook((handleBlocked) => {
      report = handleBlocked
      return () => {}
    })

    expect(entries()).toEqual([])

    act(() => {
      report!({ url: 'http://192.168.1.50/a', reason: 'private network' })
    })
    act(() => {
      report!({ url: 'http://169.254.169.254/b', reason: 'link-local' })
    })

    expect(entries()).toEqual([
      'http://192.168.1.50/a :: private network',
      'http://169.254.169.254/b :: link-local',
    ])
  })

  test('keeps the latest reason when a URL is blocked again for a new one', () => {
    let report: ((blocked: BlockedLayerURL) => void) | undefined
    const entries = renderHook((handleBlocked) => {
      report = handleBlocked
      return () => {}
    })

    act(() => {
      report!({ url: 'http://192.168.1.50/a', reason: 'private network' })
    })
    act(() => {
      report!({ url: 'http://192.168.1.50/a', reason: 'loopback host' })
    })

    expect(entries()).toEqual(['http://192.168.1.50/a :: loopback host'])
  })

  test('unsubscribes when the layer unmounts', () => {
    const unsubscribe = vi.fn()
    renderHook(() => unsubscribe)

    act(() => render(null, container!))

    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
