import EventEmitter from 'events'
import { describe, expect, it, vi } from 'vitest'
import { AppUpdater } from './appUpdater'

// electron-updater's AppUpdater is an EventEmitter with checkForUpdates(),
// downloadUpdate(), quitAndInstall() and an autoDownload flag, so a plain
// EventEmitter plus spies models it faithfully without an Electron runtime
// (and without a release feed to talk to).
class FakeElectronUpdater extends EventEmitter {
  autoDownload = true
  checkForUpdates = vi.fn(() => Promise.resolve(null))
  downloadUpdate = vi.fn(() => Promise.resolve([] as string[]))
  quitAndInstall = vi.fn()
}

function createUpdater(repository: string | null = 'NilsR0711/streamwall') {
  const backend = new FakeElectronUpdater()
  const setIntervalImpl = vi.fn(() => 'timer-handle')
  const clearIntervalImpl = vi.fn()
  const updater = new AppUpdater(backend, repository, {
    setIntervalImpl,
    clearIntervalImpl,
  })
  const statuses: unknown[] = []
  updater.on('status', (status) => statuses.push(status))
  return { backend, updater, statuses, setIntervalImpl, clearIntervalImpl }
}

const releaseUrl = 'https://github.com/NilsR0711/streamwall/releases/tag/v0.9.2'

describe('AppUpdater status', () => {
  it('starts idle so the renderer renders no banner before a check has run', () => {
    const { updater } = createUpdater()

    expect(updater.getStatus()).toEqual({ state: 'idle' })
  })

  it('turns off automatic downloads, so no bandwidth is spent without user consent', () => {
    const { backend } = createUpdater()

    expect(backend.autoDownload).toBe(false)
  })

  it('reports checking while a check is in flight', () => {
    const { backend, updater, statuses } = createUpdater()

    backend.emit('checking-for-update')

    expect(updater.getStatus()).toEqual({ state: 'checking' })
    expect(statuses).toEqual([{ state: 'checking' }])
  })

  it('announces a found update as downloadable instead of auto-downloading it', () => {
    const { backend, updater } = createUpdater()

    backend.emit('checking-for-update')
    backend.emit('update-available', { version: '0.9.2' })

    expect(updater.getStatus()).toEqual({
      state: 'available',
      version: '0.9.2',
      releaseUrl,
      canDownload: true,
    })
    expect(backend.downloadUpdate).not.toHaveBeenCalled()
  })

  it('still announces the update without a link when the repository is unknown', () => {
    const { backend, updater } = createUpdater(null)

    backend.emit('update-available', { version: '0.9.2' })

    expect(updater.getStatus()).toEqual({
      state: 'available',
      version: '0.9.2',
      releaseUrl: null,
      canDownload: true,
    })
  })

  it('returns to idle when no update is available, so a stale banner does not linger', () => {
    const { backend, updater } = createUpdater()

    backend.emit('checking-for-update')
    backend.emit('update-not-available', { version: '0.9.1' })

    expect(updater.getStatus()).toEqual({ state: 'idle' })
  })

  it('reports byte-level progress while the download runs', () => {
    const { backend, updater } = createUpdater()
    backend.emit('update-available', { version: '0.9.2' })
    updater.download()

    backend.emit('download-progress', {
      percent: 41.5,
      transferred: 415,
      total: 1000,
      delta: 415,
      bytesPerSecond: 100,
    })

    expect(updater.getStatus()).toEqual({
      state: 'downloading',
      version: '0.9.2',
      progress: { percent: 41.5, transferred: 415, total: 1000 },
    })
  })

  it('keeps the progress indeterminate when the backend reports unusable numbers', () => {
    const { backend, updater } = createUpdater()
    backend.emit('update-available', { version: '0.9.2' })
    updater.download()

    backend.emit('download-progress', {
      percent: Number.NaN,
      transferred: 0,
      total: Number.NaN,
    })

    expect(updater.getStatus()).toEqual({
      state: 'downloading',
      version: '0.9.2',
      progress: null,
    })
  })

  // One case per branch of the progress guard, so the named predicates it was
  // split into keep rejecting exactly what the original condition rejected.
  it.each([
    ['a non-object payload', 'not-an-object'],
    ['a null payload', null],
    ['an undefined payload', undefined],
    ['no fields at all', {}],
    ['a non-numeric percent', { percent: '40', transferred: 400, total: 1000 }],
    [
      'a non-numeric transferred',
      { percent: 40, transferred: '400', total: 1000 },
    ],
    ['a non-numeric total', { percent: 40, transferred: 400, total: '1000' }],
    ['a NaN percent', { percent: Number.NaN, transferred: 400, total: 1000 }],
    [
      'a NaN transferred',
      { percent: 40, transferred: Number.NaN, total: 1000 },
    ],
    ['a NaN total', { percent: 40, transferred: 400, total: Number.NaN }],
    [
      'an infinite percent',
      { percent: Number.POSITIVE_INFINITY, transferred: 400, total: 1000 },
    ],
    [
      'an infinite transferred',
      { percent: 40, transferred: Number.POSITIVE_INFINITY, total: 1000 },
    ],
    [
      'an infinite total',
      { percent: 40, transferred: 400, total: Number.POSITIVE_INFINITY },
    ],
    ['a zero total', { percent: 0, transferred: 0, total: 0 }],
    ['a negative total', { percent: 0, transferred: 0, total: -1 }],
  ])('keeps the progress indeterminate for %s', (_label, payload) => {
    const { backend, updater } = createUpdater()
    backend.emit('update-available', { version: '0.9.2' })
    updater.download()

    backend.emit('download-progress', payload)

    expect(updater.getStatus()).toEqual({
      state: 'downloading',
      version: '0.9.2',
      progress: null,
    })
  })

  it('accepts a fully measured payload down to a single-byte total', () => {
    const { backend, updater } = createUpdater()
    backend.emit('update-available', { version: '0.9.2' })
    updater.download()

    backend.emit('download-progress', { percent: 0, transferred: 0, total: 1 })

    expect(updater.getStatus()).toEqual({
      state: 'downloading',
      version: '0.9.2',
      progress: { percent: 0, transferred: 0, total: 1 },
    })
  })

  it('ignores progress events outside the downloading state', () => {
    const { backend, updater } = createUpdater()
    backend.emit('update-available', { version: '0.9.2' })

    backend.emit('download-progress', {
      percent: 40,
      transferred: 400,
      total: 1000,
    })

    expect(updater.getStatus()).toEqual({
      state: 'available',
      version: '0.9.2',
      releaseUrl,
      canDownload: true,
    })
  })

  it('reports the downloaded version and a release notes link once install is possible', () => {
    const { backend, updater } = createUpdater()
    backend.emit('update-available', { version: '0.9.2' })
    updater.download()

    backend.emit('update-downloaded', { version: '0.9.2' })

    expect(updater.getStatus()).toEqual({
      state: 'ready',
      version: '0.9.2',
      releaseNotesUrl: releaseUrl,
    })
  })

  it('still reports ready without a link when the repository is unknown, so the update stays installable', () => {
    const { backend, updater } = createUpdater(null)

    backend.emit('update-downloaded', { version: '0.9.2' })

    expect(updater.getStatus()).toEqual({
      state: 'ready',
      version: '0.9.2',
      releaseNotesUrl: null,
    })
  })

  it('surfaces updater errors instead of leaving the banner stuck on downloading', () => {
    const { backend, updater } = createUpdater()

    backend.emit('update-available', { version: '0.9.2' })
    backend.emit('error', new Error('feed unreachable'))

    expect(updater.getStatus()).toEqual({
      state: 'error',
      message: 'feed unreachable',
    })
  })

  it('emits every transition so the control window can push each one to the renderer', () => {
    const { backend, updater, statuses } = createUpdater()

    backend.emit('checking-for-update')
    backend.emit('update-available', { version: '1.0.0' })
    updater.download()
    backend.emit('update-downloaded', { version: '1.0.0' })

    expect(statuses).toEqual([
      { state: 'checking' },
      {
        state: 'available',
        version: '1.0.0',
        releaseUrl:
          'https://github.com/NilsR0711/streamwall/releases/tag/v1.0.0',
        canDownload: true,
      },
      { state: 'downloading', version: '1.0.0', progress: null },
      {
        state: 'ready',
        version: '1.0.0',
        releaseNotesUrl:
          'https://github.com/NilsR0711/streamwall/releases/tag/v1.0.0',
      },
    ])
  })
})

describe('AppUpdater download', () => {
  it('starts the download only when the user asks, reporting indeterminate progress until bytes flow', () => {
    const { backend, updater } = createUpdater()
    backend.emit('update-available', { version: '0.9.2' })

    expect(updater.download()).toBe(true)
    expect(backend.downloadUpdate).toHaveBeenCalledOnce()
    expect(updater.getStatus()).toEqual({
      state: 'downloading',
      version: '0.9.2',
      progress: null,
    })
  })

  it('refuses to download before an update was announced, so a stray IPC call cannot start one', () => {
    const { backend, updater } = createUpdater()

    expect(updater.download()).toBe(false)
    expect(backend.downloadUpdate).not.toHaveBeenCalled()
  })

  it('does not restart a download that is already running', () => {
    const { backend, updater } = createUpdater()
    backend.emit('update-available', { version: '0.9.2' })

    updater.download()
    expect(updater.download()).toBe(false)

    expect(backend.downloadUpdate).toHaveBeenCalledOnce()
  })

  it('surfaces a download that fails without an error event, so the banner cannot hang', async () => {
    const { backend, updater } = createUpdater()
    backend.downloadUpdate.mockRejectedValueOnce(new Error('disk full'))
    backend.emit('update-available', { version: '0.9.2' })

    updater.download()
    await vi.waitFor(() => {
      expect(updater.getStatus()).toEqual({
        state: 'error',
        message: 'disk full',
      })
    })
  })
})

describe('AppUpdater install', () => {
  it('quits and installs once an update has been downloaded', () => {
    const { backend, updater } = createUpdater()
    backend.emit('update-downloaded', { version: '0.9.2' })

    expect(updater.install()).toBe(true)
    expect(backend.quitAndInstall).toHaveBeenCalledOnce()
  })

  it('refuses to install before an update is downloaded, so a stray IPC call cannot quit the app', () => {
    const { backend, updater } = createUpdater()

    backend.emit('update-available', { version: '0.9.2' })

    expect(updater.install()).toBe(false)
    expect(backend.quitAndInstall).not.toHaveBeenCalled()
  })
})

describe('AppUpdater periodic checks', () => {
  it('checks immediately on start and schedules periodic re-checks', () => {
    const { backend, updater, setIntervalImpl } = createUpdater()

    updater.start()

    expect(backend.checkForUpdates).toHaveBeenCalledOnce()
    expect(setIntervalImpl).toHaveBeenCalledOnce()
  })

  it('is idempotent, so a double start does not double the check rate', () => {
    const { backend, updater, setIntervalImpl } = createUpdater()

    updater.start()
    updater.start()

    expect(backend.checkForUpdates).toHaveBeenCalledOnce()
    expect(setIntervalImpl).toHaveBeenCalledOnce()
  })

  it('stops the periodic re-checks', () => {
    const { updater, clearIntervalImpl } = createUpdater()

    updater.start()
    updater.stop()

    expect(clearIntervalImpl).toHaveBeenCalledWith('timer-handle')
  })

  it('re-checks periodically while idle', () => {
    const { backend, updater, setIntervalImpl } = createUpdater()
    updater.start()
    backend.emit('update-not-available', { version: '0.9.1' })
    const tick = setIntervalImpl.mock.calls[0][0] as () => void

    tick()

    expect(backend.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('does not re-check once an update was announced, downloaded, or is downloading, so the offer is not yanked away', () => {
    const { backend, updater, setIntervalImpl } = createUpdater()
    updater.start()
    const tick = setIntervalImpl.mock.calls[0][0] as () => void

    backend.emit('update-available', { version: '0.9.2' })
    tick()
    updater.download()
    tick()
    backend.emit('update-downloaded', { version: '0.9.2' })
    tick()

    expect(backend.checkForUpdates).toHaveBeenCalledOnce()
  })

  it('keeps checking after a failed check, so a transient network error does not disable updates', async () => {
    const { backend, updater, setIntervalImpl } = createUpdater()
    backend.checkForUpdates.mockRejectedValueOnce(new Error('offline'))
    updater.start()
    await vi.waitFor(() => {
      expect(updater.getStatus()).toEqual({
        state: 'error',
        message: 'offline',
      })
    })
    const tick = setIntervalImpl.mock.calls[0][0] as () => void

    tick()

    expect(backend.checkForUpdates).toHaveBeenCalledTimes(2)
  })
})
