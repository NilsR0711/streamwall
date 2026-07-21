import { MacUpdater, NsisUpdater } from 'electron-updater'
import { type UpdateStatus } from '../updateStatus'
import { AppUpdater } from './appUpdater'
import { type UpdateHandlers } from './ControlWindow'
import { LinuxUpdateChecker } from './linuxUpdateChecker'
import log from './logger'

/** The `controlWindow` surface the updater wiring drives. */
export interface UpdaterControlWindow {
  onUpdateStatus(status: UpdateStatus): void
  setUpdateHandlers(handlers: UpdateHandlers): void
}

/** Minimal update source shape shared by the Linux and self-updater paths. */
export interface UpdateStatusSource {
  on(event: 'status', listener: (status: UpdateStatus) => void): void
  getStatus(): UpdateStatus
  start(): void
}

/** A self-updater that can also download and install (macOS / Windows). */
export interface SelfUpdater extends UpdateStatusSource {
  download(): void
  install(): void
}

export interface SetupAppUpdaterContext {
  platform: NodeJS.Platform
  isPackaged: boolean
  currentVersion: string
  repositorySlug: string | null
  controlWindow: UpdaterControlWindow
  /** Opens a URL in the user's default browser (Electron's `shell.openExternal`). */
  openExternal: (url: string) => void
  /**
   * Builds the notify-only Linux checker. Injectable so the wiring can be
   * tested without electron-updater; defaults to the real implementation.
   */
  createLinuxUpdateChecker?: (opts: {
    currentVersion: string
    repository: string | null
  }) => UpdateStatusSource
  /**
   * Builds the macOS/Windows self-updater. Injectable so the wiring can be
   * tested without electron-updater; defaults to the real implementation.
   */
  createSelfUpdater?: (
    platform: NodeJS.Platform,
    repositorySlug: string | null,
  ) => SelfUpdater
}

function defaultCreateLinuxUpdateChecker(opts: {
  currentVersion: string
  repository: string | null
}): UpdateStatusSource {
  return new LinuxUpdateChecker(opts)
}

function defaultCreateSelfUpdater(
  platform: NodeJS.Platform,
  repositorySlug: string | null,
): SelfUpdater {
  const backend = platform === 'darwin' ? new MacUpdater() : new NsisUpdater()
  backend.logger = log
  if (repositorySlug) {
    const [owner, repo] = repositorySlug.split('/')
    backend.setFeedURL({ provider: 'github', owner, repo })
  }
  return new AppUpdater(backend, repositorySlug)
}

/**
 * Wires the application auto-updater to the control window.
 *
 * electron-updater has no self-update story for .deb/.rpm installs, so on Linux
 * a notify-only GitHub Releases poll is used that only ever offers a link (the
 * OS package manager, not a self-updater, applies the update — #433). Every
 * other platform uses electron-updater instead of Electron's built-in Squirrel
 * autoUpdater (#432): Squirrel starts downloading as soon as it finds an update
 * and reports no byte-level progress, so it could neither ask for consent nor
 * show download progress. The release feed is GitHub Releases, with
 * latest.yml/latest-mac.yml generated at publish time (see
 * forge.updateMetadata.ts).
 */
export function setupAppUpdater(ctx: SetupAppUpdaterContext): void {
  const {
    platform,
    isPackaged,
    currentVersion,
    repositorySlug,
    controlWindow,
    openExternal,
    createLinuxUpdateChecker = defaultCreateLinuxUpdateChecker,
    createSelfUpdater = defaultCreateSelfUpdater,
  } = ctx

  if (platform === 'linux') {
    const linuxUpdateChecker = createLinuxUpdateChecker({
      currentVersion,
      repository: repositorySlug,
    })
    linuxUpdateChecker.on('status', (status) => {
      log.debug('Update status:', status.state)
      controlWindow.onUpdateStatus(status)
    })
    controlWindow.setUpdateHandlers({
      getAppVersion: () => currentVersion,
      getStatus: () => linuxUpdateChecker.getStatus(),
      download: () => {
        // Never reachable from the banner (`available` carries
        // `canDownload: false` on Linux), but the handler bundle requires one.
      },
      install: () => {
        // Never reachable from the banner (no install action is offered for
        // `available`), but the handler bundle requires one.
      },
      openReleaseNotes: () => {
        const status = linuxUpdateChecker.getStatus()
        if (status.state === 'available' && status.releaseUrl) {
          openExternal(status.releaseUrl)
        }
      },
    })
    linuxUpdateChecker.start()
    return
  }

  const selfUpdater = createSelfUpdater(platform, repositorySlug)
  selfUpdater.on('status', (status) => {
    if (status.state === 'error') {
      // Not surfaced in the UI: a failed update check is routine (offline,
      // rate limit) and not actionable by the user.
      log.warn('Update check failed:', status.message)
    } else {
      log.debug('Update status:', status.state)
    }
    controlWindow.onUpdateStatus(status)
  })
  controlWindow.setUpdateHandlers({
    getAppVersion: () => currentVersion,
    getStatus: () => selfUpdater.getStatus(),
    download: () => selfUpdater.download(),
    install: () => selfUpdater.install(),
    openReleaseNotes: () => {
      const status = selfUpdater.getStatus()
      if (status.state === 'available' && status.releaseUrl) {
        openExternal(status.releaseUrl)
      } else if (status.state === 'ready' && status.releaseNotesUrl) {
        openExternal(status.releaseNotesUrl)
      }
    },
  })
  // In development there is no packaged app to update against; electron-updater
  // would just log a skip message every interval.
  if (isPackaged && repositorySlug) {
    selfUpdater.start()
  }
}
