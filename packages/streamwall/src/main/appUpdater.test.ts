import EventEmitter from 'events'
import { describe, expect, it, vi } from 'vitest'
import { AppUpdater } from './appUpdater'

// Electron's built-in autoUpdater is an EventEmitter with a quitAndInstall()
// method, so a plain EventEmitter plus a spy models it faithfully without an
// Electron runtime (and without a Squirrel feed to talk to).
class FakeAutoUpdater extends EventEmitter {
  quitAndInstall = vi.fn()
}

function createUpdater(repository: string | null = 'NilsR0711/streamwall') {
  const autoUpdater = new FakeAutoUpdater()
  const updater = new AppUpdater(autoUpdater, repository)
  const statuses: unknown[] = []
  updater.on('status', (status) => statuses.push(status))
  return { autoUpdater, updater, statuses }
}

describe('AppUpdater status', () => {
  it('starts idle so the renderer renders no banner before a check has run', () => {
    const { updater } = createUpdater()

    expect(updater.getStatus()).toEqual({ state: 'idle' })
  })

  it('reports checking while a check is in flight', () => {
    const { autoUpdater, updater, statuses } = createUpdater()

    autoUpdater.emit('checking-for-update')

    expect(updater.getStatus()).toEqual({ state: 'checking' })
    expect(statuses).toEqual([{ state: 'checking' }])
  })

  it('reports downloading once an update is found, since Squirrel downloads it automatically', () => {
    const { autoUpdater, updater } = createUpdater()

    autoUpdater.emit('checking-for-update')
    autoUpdater.emit('update-available')

    expect(updater.getStatus()).toEqual({ state: 'downloading' })
  })

  it('returns to idle when no update is available, so a stale banner does not linger', () => {
    const { autoUpdater, updater } = createUpdater()

    autoUpdater.emit('checking-for-update')
    autoUpdater.emit('update-not-available')

    expect(updater.getStatus()).toEqual({ state: 'idle' })
  })

  it('reports the downloaded version and a release notes link once install is possible', () => {
    const { autoUpdater, updater } = createUpdater()

    autoUpdater.emit('update-downloaded', {}, 'release notes', 'v0.9.2')

    expect(updater.getStatus()).toEqual({
      state: 'ready',
      version: '0.9.2',
      releaseNotesUrl:
        'https://github.com/NilsR0711/streamwall/releases/tag/v0.9.2',
    })
  })

  it('still reports ready without a link when the repository is unknown, so the update stays installable', () => {
    const { autoUpdater, updater } = createUpdater(null)

    autoUpdater.emit('update-downloaded', {}, 'release notes', '0.9.2')

    expect(updater.getStatus()).toEqual({
      state: 'ready',
      version: '0.9.2',
      releaseNotesUrl: null,
    })
  })

  it('surfaces updater errors instead of leaving the banner stuck on downloading', () => {
    const { autoUpdater, updater } = createUpdater()

    autoUpdater.emit('update-available')
    autoUpdater.emit('error', new Error('feed unreachable'))

    expect(updater.getStatus()).toEqual({
      state: 'error',
      message: 'feed unreachable',
    })
  })

  it('emits every transition so the control window can push each one to the renderer', () => {
    const { autoUpdater, statuses } = createUpdater()

    autoUpdater.emit('checking-for-update')
    autoUpdater.emit('update-available')
    autoUpdater.emit('update-downloaded', {}, '', 'v1.0.0')

    expect(statuses).toEqual([
      { state: 'checking' },
      { state: 'downloading' },
      {
        state: 'ready',
        version: '1.0.0',
        releaseNotesUrl:
          'https://github.com/NilsR0711/streamwall/releases/tag/v1.0.0',
      },
    ])
  })
})

describe('AppUpdater install', () => {
  it('quits and installs once an update has been downloaded', () => {
    const { autoUpdater, updater } = createUpdater()
    autoUpdater.emit('update-downloaded', {}, '', 'v0.9.2')

    expect(updater.install()).toBe(true)
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledOnce()
  })

  it('refuses to install before an update is downloaded, so a stray IPC call cannot quit the app', () => {
    const { autoUpdater, updater } = createUpdater()

    autoUpdater.emit('update-available')

    expect(updater.install()).toBe(false)
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })
})
