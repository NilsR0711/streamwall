import EventEmitter from 'node:events'
import {
  normalizeVersion,
  releaseNotesUrl,
  type DownloadProgress,
  type UpdateStatus,
} from '../updateStatus'

type UpdaterListener = (...args: unknown[]) => void

/**
 * The slice of electron-updater's `AppUpdater` this module drives. Narrow on
 * purpose: it keeps the updater testable against a plain EventEmitter, and
 * documents exactly which electron-updater behaviors the app depends on.
 */
export interface ElectronUpdaterLike {
  autoDownload: boolean
  on(event: string, listener: UpdaterListener): unknown
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(): void
}

export interface AppUpdaterEventMap {
  status: [UpdateStatus]
}

export interface AppUpdaterOptions {
  intervalMs?: number
  setIntervalImpl?: (fn: () => void, ms: number) => unknown
  clearIntervalImpl?: (handle: unknown) => void
}

/**
 * Matches update-electron-app's default cadence, which drove the checks
 * before the switch to electron-updater (#432).
 */
const DEFAULT_CHECK_INTERVAL_MS = 10 * 60 * 1000

/** Node's `setInterval` handle keeps the event loop alive; unref'ing it means a pending check never delays app shutdown. */
function defaultSetInterval(fn: () => void, ms: number): unknown {
  const handle = setInterval(fn, ms)
  handle.unref?.()
  return handle
}

/**
 * Translates electron-updater's events into the `UpdateStatus` the control
 * window renders, and owns the check/download/install lifecycle (#381, #432):
 *
 * - `autoDownload` is forced off, so a found update is only *announced*
 *   (`available`) and no bandwidth is spent until `download()` - the user's
 *   explicit consent - which matters for a tool typically run during live
 *   streaming.
 * - `download-progress` events become byte-level `downloading` progress; the
 *   UI falls back to an indeterminate indicator until the first event.
 * - `quitAndInstall()` is gated behind a downloaded update, and
 *   `downloadUpdate()` behind an announced one, so stray IPC calls can
 *   neither quit the app mid-stream nor start surprise downloads.
 *
 * It also owns the periodic re-check (previously update-electron-app's job):
 * re-checks only run from idle-ish states, so an offer the user is looking
 * at - or a download in flight - is never yanked away by a fresh check.
 */
export class AppUpdater extends EventEmitter<AppUpdaterEventMap> {
  private status: UpdateStatus = { state: 'idle' }
  private timer: unknown = null

  constructor(
    private readonly backend: ElectronUpdaterLike,
    private readonly repository: string | null,
    private readonly options: AppUpdaterOptions = {},
  ) {
    super()

    // The consent gate (#432): announce first, download on request.
    this.backend.autoDownload = false

    this.backend.on('checking-for-update', () => {
      this.setStatus({ state: 'checking' })
    })

    this.backend.on('update-available', (...args: unknown[]) => {
      const version = extractVersion(args[0])
      this.setStatus({
        state: 'available',
        version,
        releaseUrl: releaseNotesUrl(this.repository, version),
        canDownload: true,
      })
    })

    this.backend.on('update-not-available', () => {
      this.setStatus({ state: 'idle' })
    })

    this.backend.on('download-progress', (...args: unknown[]) => {
      if (this.status.state !== 'downloading') {
        return
      }
      this.setStatus({
        state: 'downloading',
        version: this.status.version,
        progress: extractProgress(args[0]),
      })
    })

    this.backend.on('update-downloaded', (...args: unknown[]) => {
      const version = extractVersion(args[0])
      this.setStatus({
        state: 'ready',
        version,
        releaseNotesUrl: releaseNotesUrl(this.repository, version),
      })
    })

    this.backend.on('error', (...args: unknown[]) => {
      this.setError(args[0])
    })
  }

  getStatus(): UpdateStatus {
    return this.status
  }

  /**
   * Starts the download of an announced update. Returns whether one was
   * actually started: the renderer's download button is only shown in the
   * `available` state, but the IPC channel is guarded here too so a stray
   * call cannot start a surprise download - or restart a running one.
   */
  download(): boolean {
    if (this.status.state !== 'available') {
      return false
    }
    this.setStatus({
      state: 'downloading',
      version: this.status.version,
      progress: null,
    })
    // electron-updater emits `error` for download failures too; this catch
    // covers a rejection without one, so the banner cannot hang on
    // "downloading" forever.
    this.backend.downloadUpdate().catch((err: unknown) => {
      this.setError(err)
    })
    return true
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
    this.backend.quitAndInstall()
    return true
  }

  /** Runs an initial check and schedules periodic ones. Idempotent. */
  start() {
    if (this.timer !== null) {
      return
    }
    this.check()
    const setIntervalImpl = this.options.setIntervalImpl ?? defaultSetInterval
    this.timer = setIntervalImpl(() => {
      // Never re-check over an announced offer, a running download, or a
      // downloaded update: electron-updater would cycle back through
      // `checking`, yanking the banner away from the user.
      if (
        this.status.state === 'idle' ||
        this.status.state === 'checking' ||
        this.status.state === 'error'
      ) {
        this.check()
      }
    }, this.options.intervalMs ?? DEFAULT_CHECK_INTERVAL_MS)
  }

  stop() {
    if (this.timer !== null) {
      const clearIntervalImpl =
        this.options.clearIntervalImpl ??
        ((handle: unknown) => clearInterval(handle as NodeJS.Timeout))
      clearIntervalImpl(this.timer)
      this.timer = null
    }
  }

  private check() {
    // Failures also arrive as `error` events; the catch keeps a rejected
    // promise from becoming an unhandled rejection.
    this.backend.checkForUpdates().catch((err: unknown) => {
      this.setError(err)
    })
  }

  private setError(error: unknown) {
    this.setStatus({
      state: 'error',
      message: error instanceof Error ? error.message : String(error),
    })
  }

  private setStatus(status: UpdateStatus) {
    this.status = status
    this.emit('status', status)
  }
}

/** electron-updater's UpdateInfo always carries `version`; degrade to '' rather than crash on a malformed event. */
function extractVersion(info: unknown): string {
  const version =
    typeof info === 'object' &&
    info !== null &&
    'version' in info &&
    typeof info.version === 'string'
      ? info.version
      : ''
  return normalizeVersion(version)
}

/**
 * Reduces electron-updater's ProgressInfo to the fields the banner renders.
 * Anything non-finite (e.g. an unknown total on a server that omits
 * Content-Length) yields null, which the UI shows as indeterminate.
 */
function extractProgress(info: unknown): DownloadProgress | null {
  if (typeof info !== 'object' || info === null) {
    return null
  }
  const { percent, transferred, total } = info as Record<string, unknown>

  // A NaN/Infinity (or entirely absent) field means the backend cannot measure
  // this download - e.g. a server that omits Content-Length.
  const allFieldsMeasured =
    isFiniteNumber(percent) &&
    isFiniteNumber(transferred) &&
    isFiniteNumber(total)
  if (!allFieldsMeasured) {
    return null
  }

  // A zero or negative total would make the banner's percentage meaningless.
  //
  // `total` is only usable as `number` here because TypeScript narrows it
  // through `allFieldsMeasured` above: a `const` holding a direct `&&` chain
  // is one of the aliased conditions control-flow analysis understands, so
  // `if (!allFieldsMeasured) return` also narrows `total`. Pulling that
  // chain into a helper function, or turning `allFieldsMeasured` into a
  // `let`, silently drops the narrowing and forces a cast back to `number`
  // here - keep this a `const` with the `&&` chain inline.
  const hasKnownTotal = total > 0
  if (!hasKnownTotal) {
    return null
  }

  return { percent, transferred, total }
}

/** Guards against both non-numeric fields and the NaN/Infinity a stalled or unmeasurable download reports. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
