import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { type ServerStatus, useServerStatus } from './useServerStatus.ts'

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
    expect(fetchMock).toHaveBeenCalledWith('/admin/status', {
      credentials: 'same-origin',
    })
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
})
