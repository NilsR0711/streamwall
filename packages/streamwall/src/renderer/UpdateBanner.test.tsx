// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { type UpdateStatus } from '../updateStatus'
import { UpdateBanner } from './UpdateBanner'

let container: HTMLDivElement | undefined

afterEach(() => {
  if (container) {
    act(() => render(null, container!))
    container.remove()
    container = undefined
  }
})

function renderBanner(
  status: UpdateStatus,
  props: { currentVersion?: string } = {},
) {
  container = document.createElement('div')
  document.body.appendChild(container)
  const onDownload = vi.fn()
  const onInstall = vi.fn()
  const onOpenReleaseNotes = vi.fn()
  const onDismiss = vi.fn()
  act(() => {
    render(
      <UpdateBanner
        status={status}
        currentVersion={props.currentVersion ?? '0.9.1'}
        onDownload={onDownload}
        onInstall={onInstall}
        onOpenReleaseNotes={onOpenReleaseNotes}
        onDismiss={onDismiss}
      />,
      container!,
    )
  })
  return { onDownload, onInstall, onOpenReleaseNotes, onDismiss }
}

function click(testId: string) {
  const button = container!.querySelector<HTMLButtonElement>(
    `[data-testid="${testId}"]`,
  )
  act(() => button!.click())
}

describe('UpdateBanner visibility', () => {
  test('renders nothing while idle, so a healthy up-to-date app shows no chrome', () => {
    renderBanner({ state: 'idle' })

    expect(container!.textContent).toBe('')
  })

  test('renders nothing while checking, so a routine background check stays invisible', () => {
    renderBanner({ state: 'checking' })

    expect(container!.textContent).toBe('')
  })

  test('renders nothing on error, since a failed update check is not actionable for the user', () => {
    renderBanner({ state: 'error', message: 'feed unreachable' })

    expect(container!.textContent).toBe('')
  })
})

describe('UpdateBanner available for download', () => {
  const availableStatus: UpdateStatus = {
    state: 'available',
    version: '0.9.2',
    releaseUrl: 'https://github.com/NilsR0711/streamwall/releases/tag/v0.9.2',
    canDownload: true,
  }

  test('names the new version and the version being replaced', () => {
    renderBanner(availableStatus, { currentVersion: '0.9.1' })

    expect(container!.textContent).toContain('0.9.2')
    expect(container!.textContent).toContain('0.9.1')
  })

  test('offers a download action, so no bandwidth is spent without consent', () => {
    const { onDownload } = renderBanner(availableStatus)

    click('download-update')

    expect(onDownload).toHaveBeenCalledOnce()
  })

  test('offers no install action before anything was downloaded', () => {
    renderBanner(availableStatus)

    expect(
      container!.querySelector('[data-testid="install-update"]'),
    ).toBeNull()
  })

  test('opens the release page externally rather than navigating the control window', () => {
    const { onOpenReleaseNotes } = renderBanner(availableStatus)

    click('open-release-notes')

    expect(onOpenReleaseNotes).toHaveBeenCalledWith(availableStatus.releaseUrl)
  })

  test('omits the release notes action when no link is known', () => {
    renderBanner({ ...availableStatus, releaseUrl: null })

    expect(
      container!.querySelector('[data-testid="open-release-notes"]'),
    ).toBeNull()
  })

  test('can be dismissed, keeping the notification non-intrusive', () => {
    const { onDismiss } = renderBanner(availableStatus)

    click('dismiss-update-banner')

    expect(onDismiss).toHaveBeenCalledOnce()
  })
})

describe('UpdateBanner available on Linux (notify-only)', () => {
  const availableStatus: UpdateStatus = {
    state: 'available',
    version: '0.9.2',
    releaseUrl: 'https://github.com/NilsR0711/streamwall/releases/tag/v0.9.2',
    canDownload: false,
  }

  test('offers no download or install action, since Linux updates go through the package manager', () => {
    renderBanner(availableStatus)

    expect(
      container!.querySelector('[data-testid="download-update"]'),
    ).toBeNull()
    expect(
      container!.querySelector('[data-testid="install-update"]'),
    ).toBeNull()
  })

  test('opens the release page externally rather than navigating the control window', () => {
    const { onOpenReleaseNotes } = renderBanner(availableStatus)

    click('view-release')

    expect(onOpenReleaseNotes).toHaveBeenCalledWith(availableStatus.releaseUrl)
  })

  test('can be dismissed, keeping the notification non-intrusive', () => {
    const { onDismiss } = renderBanner(availableStatus)

    click('dismiss-update-banner')

    expect(onDismiss).toHaveBeenCalledOnce()
  })
})

describe('UpdateBanner downloading', () => {
  test('tells the user which version is downloading so the wait is explained', () => {
    renderBanner({ state: 'downloading', version: '0.9.2', progress: null })

    expect(container!.textContent).toContain('Downloading')
    expect(container!.textContent).toContain('0.9.2')
  })

  test('shows a busy indicator until the first byte counts arrive', () => {
    renderBanner({ state: 'downloading', version: '0.9.2', progress: null })

    const progress = container!.querySelector('[role="progressbar"]')
    expect(progress).not.toBeNull()
    expect(progress!.getAttribute('aria-valuenow')).toBeNull()
  })

  test('shows determinate progress with the reported percentage', () => {
    renderBanner({
      state: 'downloading',
      version: '0.9.2',
      progress: { percent: 41.5, transferred: 43_515_904, total: 104_857_600 },
    })

    const progress = container!.querySelector('[role="progressbar"]')
    expect(progress!.getAttribute('aria-valuenow')).toBe('42')
    expect(container!.textContent).toContain('42%')
  })

  test('shows transferred and total megabytes so the cost of the download is visible', () => {
    renderBanner({
      state: 'downloading',
      version: '0.9.2',
      progress: { percent: 41.5, transferred: 43_515_904, total: 104_857_600 },
    })

    expect(container!.textContent).toContain('41.5 MB')
    expect(container!.textContent).toContain('100 MB')
  })

  test('offers no install action before the download finished', () => {
    renderBanner({ state: 'downloading', version: '0.9.2', progress: null })

    expect(
      container!.querySelector('[data-testid="install-update"]'),
    ).toBeNull()
  })
})

describe('UpdateBanner ready', () => {
  const readyStatus: UpdateStatus = {
    state: 'ready',
    version: '0.9.2',
    releaseNotesUrl:
      'https://github.com/NilsR0711/streamwall/releases/tag/v0.9.2',
  }

  test('names the new version and the version being replaced', () => {
    renderBanner(readyStatus, { currentVersion: '0.9.1' })

    expect(container!.textContent).toContain('0.9.2')
    expect(container!.textContent).toContain('0.9.1')
  })

  test('installs and restarts when the install action is clicked', () => {
    const { onInstall } = renderBanner(readyStatus)

    click('install-update')

    expect(onInstall).toHaveBeenCalledOnce()
  })

  test('opens the release notes externally rather than navigating the control window', () => {
    const { onOpenReleaseNotes } = renderBanner(readyStatus)

    click('open-release-notes')

    expect(onOpenReleaseNotes).toHaveBeenCalledWith(readyStatus.releaseNotesUrl)
  })

  test('omits the release notes action when no link is known', () => {
    renderBanner({ ...readyStatus, releaseNotesUrl: null })

    expect(
      container!.querySelector('[data-testid="open-release-notes"]'),
    ).toBeNull()
  })

  test('can be dismissed, keeping the notification non-intrusive', () => {
    const { onDismiss } = renderBanner(readyStatus)

    click('dismiss-update-banner')

    expect(onDismiss).toHaveBeenCalledOnce()
  })
})
