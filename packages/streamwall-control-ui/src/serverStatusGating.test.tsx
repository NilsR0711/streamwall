import { render } from 'preact'
import { act } from 'preact/test-utils'
import type { ServerStatus, StreamwallRole } from 'streamwall-shared'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import * as Y from 'yjs'
import type { StreamwallConnection } from './index.tsx'
import { ControlUI } from './index.tsx'

// react-icons renders through preact/compat's Context.Consumer, which
// currently crashes under this package's happy-dom test environment
// (unrelated to the server status under test here) - stub the icons out so
// the component can render.
vi.mock('react-icons/fa', () => ({
  FaExchangeAlt: () => null,
  FaExclamationTriangle: () => null,
  FaRedoAlt: () => null,
  FaRegLifeRing: () => null,
  FaRegWindowMaximize: () => null,
  FaSyncAlt: () => null,
  FaVideoSlash: () => null,
  FaVolumeUp: () => null,
}))
vi.mock('react-icons/md', () => ({
  MdOutlineStayCurrentLandscape: () => null,
  MdOutlineStayCurrentPortrait: () => null,
}))
// react-hotkeys-hook calls into React internals that don't cooperate with
// this package's Preact/compat test environment (unrelated to the server
// status under test here) - stub it out so the component can render.
vi.mock('react-hotkeys-hook', () => ({
  useHotkeys: () => {},
}))

let container: HTMLDivElement | undefined
let fetchMock: ReturnType<typeof vi.fn>

const ADMIN_STATUS: ServerStatus = {
  version: '0.9.1',
  latestVersion: '1.0.0',
  updateAvailable: true,
  releaseUrl: 'https://github.com/NilsR0711/streamwall/releases/tag/v1.0.0',
  lastCheckedAt: '2026-07-20T09:00:00.000Z',
  checkEnabled: true,
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

async function renderControlUI(role: StreamwallRole): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)

  const connection: StreamwallConnection = {
    isConnected: true,
    role,
    send: () => {},
    sharedState: { views: {} },
    stateDoc: new Y.Doc(),
    config: undefined,
    streams: [],
    customStreams: [],
    views: [],
    fullscreenViewIdx: null,
    stateIdxMap: new Map(),
    delayState: null,
    authState: undefined,
    layoutPresets: [],
    favorites: [],
    dataSourceHealth: [],
  }

  await act(async () => {
    render(<ControlUI connection={connection} />, container!)
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  return container
}

describe('server status gating (#436)', () => {
  test('an admin sees the running version and an available update', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(ADMIN_STATUS),
    })
    const el = await renderControlUI('admin')
    expect(fetchMock).toHaveBeenCalledWith(
      '/admin/status',
      expect.objectContaining({ credentials: 'same-origin' }),
    )
    expect(el.querySelector('.server-version-label')?.textContent).toContain(
      '0.9.1',
    )
    expect(el.querySelector('.server-update-banner')).not.toBeNull()
  })

  test('a non-admin role never requests /admin/status', async () => {
    const el = await renderControlUI('operator')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(el.querySelector('.server-version-label')).toBeNull()
    expect(el.querySelector('.server-update-banner')).toBeNull()
  })

  test('the desktop app (role "local") never requests /admin/status', async () => {
    const el = await renderControlUI('local')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(el.querySelector('.server-version-label')).toBeNull()
    expect(el.querySelector('.server-update-banner')).toBeNull()
  })

  test('a 403 response (session lost admin) shows neither version nor banner', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: () => Promise.resolve(null),
    })
    const el = await renderControlUI('admin')
    expect(el.querySelector('.server-version-label')).toBeNull()
    expect(el.querySelector('.server-update-banner')).toBeNull()
  })
})
