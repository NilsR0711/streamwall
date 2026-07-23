import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  REFRESH_INTERVAL_MS,
  type ServerStatus,
  useServerStatus,
} from './useServerStatus.ts'

let container: HTMLDivElement | undefined
let fetchMock: ReturnType<typeof vi.fn>

const SAMPLE_STATUS: ServerStatus = {
  version: '0.9.1',
  latestVersion: '1.0.0',
  updateAvailable: true,
  releaseUrl: 'https://github.com/NilsR0711/streamwall/releases/tag/v1.0.0',
  lastCheckedAt: '2026-07-20T09:00:00.000Z',
  checkEnabled: true,
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as Response
}

function Probe({ enabled }: { enabled: boolean }) {
  const status = useServerStatus(enabled)
  return <div data-testid="probe">{JSON.stringify(status)}</div>
}

async function renderProbe(enabled: boolean) {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    render(<Probe enabled={enabled} />, container!)
  })
  // Flush the fetch promise chain.
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  return container
}

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  if (container) {
    act(() => render(null, container!))
    container.remove()
    container = undefined
  }
  vi.unstubAllGlobals()
})

describe('useServerStatus', () => {
  test('does not fetch while disabled', async () => {
    const el = await renderProbe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(el.querySelector('[data-testid="probe"]')?.textContent).toBe('null')
  })

  test('fetches /admin/status with same-origin credentials when enabled', async () => {
    fetchMock.mockResolvedValue(jsonResponse(SAMPLE_STATUS))
    await renderProbe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      '/admin/status',
      expect.objectContaining({
        credentials: 'same-origin',
        signal: expect.any(AbortSignal),
      }),
    )
  })

  test('exposes the parsed status on success', async () => {
    fetchMock.mockResolvedValue(jsonResponse(SAMPLE_STATUS))
    const el = await renderProbe(true)
    expect(
      JSON.parse(el.querySelector('[data-testid="probe"]')!.textContent!),
    ).toEqual(SAMPLE_STATUS)
  })

  test('treats a 403 (non-admin) as no status rather than an error', async () => {
    fetchMock.mockResolvedValue(jsonResponse(null, false, 403))
    const el = await renderProbe(true)
    expect(el.querySelector('[data-testid="probe"]')?.textContent).toBe('null')
  })

  test('treats a network failure as no status', async () => {
    fetchMock.mockRejectedValue(new Error('network down'))
    const el = await renderProbe(true)
    expect(el.querySelector('[data-testid="probe"]')?.textContent).toBe('null')
  })

  test('rejects a malformed body (fails zod validation) as no status', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ version: 42, updateAvailable: 'yes' }),
    )
    const el = await renderProbe(true)
    expect(el.querySelector('[data-testid="probe"]')?.textContent).toBe('null')
  })

  test('keeps the last known-good status when a later refresh fails', async () => {
    vi.useFakeTimers()
    try {
      fetchMock.mockResolvedValueOnce(jsonResponse(SAMPLE_STATUS))
      fetchMock.mockRejectedValueOnce(new Error('network blip'))

      container = document.createElement('div')
      document.body.appendChild(container)
      await act(async () => {
        render(<Probe enabled />, container!)
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      const probe = () =>
        container!.querySelector('[data-testid="probe"]')?.textContent

      expect(JSON.parse(probe()!)).toEqual(SAMPLE_STATUS)

      // Second poll rejects; the good status must stay on screen.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS)
      })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(JSON.parse(probe()!)).toEqual(SAMPLE_STATUS)
    } finally {
      vi.useRealTimers()
    }
  })

  test('re-fetches /admin/status on the refresh interval', async () => {
    vi.useFakeTimers()
    try {
      fetchMock.mockResolvedValue(jsonResponse(SAMPLE_STATUS))

      container = document.createElement('div')
      document.body.appendChild(container)
      await act(async () => {
        render(<Probe enabled />, container!)
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS)
      })
      expect(fetchMock).toHaveBeenCalledTimes(2)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS)
      })
      expect(fetchMock).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  test('stops polling and aborts the request on unmount', async () => {
    vi.useFakeTimers()
    try {
      fetchMock.mockResolvedValue(jsonResponse(SAMPLE_STATUS))

      container = document.createElement('div')
      document.body.appendChild(container)
      await act(async () => {
        render(<Probe enabled />, container!)
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const signal = fetchMock.mock.calls[0][1].signal as AbortSignal
      expect(signal.aborted).toBe(false)

      // Unmount: the interval must be cleared and the inflight request aborted.
      await act(async () => {
        render(null, container!)
      })
      expect(signal.aborted).toBe(true)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS * 3)
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
