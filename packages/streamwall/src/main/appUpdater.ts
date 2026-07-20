import EventEmitter from 'node:events'
import {
  normalizeVersion,
  releaseNotesUrl,
  type UpdateStatus,
} from '../updateStatus'

type UpdaterListener = (...args: unknown[]) => void

/**
 * The slice of Electron's `autoUpdater` this module drives. Narrow on purpose:
 * it keeps the updater testable against a plain EventEmitter, and documents
 * that nothing here depends on Squirrel internals.
 */
export interface AutoUpdaterLike {
  on(event: string, listener: UpdaterListener): unknown
  quitAndInstall(): void
}

export interface AppUpdaterEventMap {
  status: [UpdateStatus]
}

/**
 * Translates Electron's `autoUpdater` events into the `UpdateStatus` the
 * control window renders, and gates `quitAndInstall()` behind a downloaded
 * update.
 *
 * `update-electron-app` (see main/index.ts) still owns the feed URL and the
 * periodic check; it runs with `notifyUser: false` so its native dialog does
 * not compete with the in-app banner this drives.
 *
 * Note what Squirrel does *not* give us, since it shapes the UI (#381):
 * `update-available` fires without a version and the download starts
 * immediately, and there is no download-progress event. So the banner shows an
 * indeterminate "Downloading" state rather than a percentage, and the version
 * only becomes known at `update-downloaded`. A determinate progress bar and a
 * user-gated download would require swapping Squirrel for `electron-updater`
 * (tracked separately).
 */
export class AppUpdater extends EventEmitter<AppUpdaterEventMap> {
  private status: UpdateStatus = { state: 'idle' }

  constructor(
    private readonly autoUpdater: AutoUpdaterLike,
    private readonly repository: string | null,
  ) {
    super()

    this.autoUpdater.on('checking-for-update', () => {
      this.setStatus({ state: 'checking' })
    })

    this.autoUpdater.on('update-available', () => {
      this.setStatus({ state: 'downloading' })
    })

    this.autoUpdater.on('update-not-available', () => {
      this.setStatus({ state: 'idle' })
    })

    this.autoUpdater.on('update-downloaded', (...args: unknown[]) => {
      // Squirrel's signature is (event, releaseNotes, releaseName, ...).
      const releaseName = typeof args[2] === 'string' ? args[2] : ''
      this.setStatus({
        state: 'ready',
        version: normalizeVersion(releaseName),
        releaseNotesUrl: releaseNotesUrl(this.repository, releaseName),
      })
    })

    this.autoUpdater.on('error', (...args: unknown[]) => {
      const error = args[0]
      this.setStatus({
        state: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    })
  }

  getStatus(): UpdateStatus {
    return this.status
  }

  /**
   * Restarts into the downloaded update. Returns whether the install was
   * actually started: the renderer's install button is only enabled in the
   * `ready` state, but the IPC channel is guarded here too so a stray call
   * cannot quit the app mid-stream.
   */
  install(): boolean {
    if (this.status.state !== 'ready') {
      return false
    }
    this.autoUpdater.quitAndInstall()
    return true
  }

  private setStatus(status: UpdateStatus) {
    this.status = status
    this.emit('status', status)
  }
}
