import fetch from 'node-fetch'
import EventEmitter from 'node:events'
import {
  fetchLatestGithubRelease,
  isNewerVersion,
  type GithubReleaseFetchImpl,
} from 'streamwall-shared'
import { type UpdateStatus } from '../updateStatus'

/**
 * Linux update notifications (#433).
 *
 * electron-updater has no self-update story for `.deb`/`.rpm` installs, so
 * main/index.ts never touches `appUpdater.ts` on Linux.
 * This polls the GitHub Releases API directly instead, and is deliberately
 * notify-only: it never downloads or installs anything, since `.deb`/`.rpm`
 * users expect their package manager to handle installs, matching platform
 * convention (see the issue). The `available` state it produces has no install
 * action - main/index.ts wires it to open the release page instead.
 */

/** Once a day: releases are rare, and this keeps the GitHub API load trivial. */
const DEFAULT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

const DEFAULT_FETCH_TIMEOUT_MS = 10_000

export interface LinuxUpdateCheckerEventMap {
  status: [UpdateStatus]
}

export interface LinuxUpdateCheckerOptions {
  currentVersion: string
  /** `owner/name` slug; a check is a no-op when this is unknown. */
  repository: string | null
  fetchImpl?: GithubReleaseFetchImpl
  intervalMs?: number
  timeoutMs?: number
  setIntervalImpl?: (fn: () => void, ms: number) => unknown
  clearIntervalImpl?: (handle: unknown) => void
}

/** Node's `setInterval` handle keeps the event loop alive; unref'ing it means a pending check never delays app shutdown. */
function defaultSetInterval(fn: () => void, ms: number): unknown {
  const handle = setInterval(fn, ms)
  handle.unref?.()
  return handle
}

/** Polls GitHub Releases for a newer version, since Squirrel cannot on Linux (#433). */
export class LinuxUpdateChecker extends EventEmitter<LinuxUpdateCheckerEventMap> {
  private status: UpdateStatus = { state: 'idle' }
  private timer: unknown = null

  constructor(private readonly options: LinuxUpdateCheckerOptions) {
    super()
  }

  getStatus(): UpdateStatus {
    return this.status
  }

  /**
   * Runs a single check. On any failure the previous status is kept as-is: a
   * transient network hiccup (offline machine, rate limit) must not hide an
   * update notice the user has already seen, matching
   * streamwall-control-server's updateCheck.ts.
   */
  async checkNow(): Promise<UpdateStatus> {
    const { repository, currentVersion } = this.options
    if (!repository) {
      return this.status
    }
    const release = await fetchLatestGithubRelease({
      url: `https://api.github.com/repos/${repository}/releases/latest`,
      fetchImpl:
        this.options.fetchImpl ?? (fetch as unknown as GithubReleaseFetchImpl),
      timeoutMs: this.options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
    })
    if (!release) {
      return this.status
    }
    const nextStatus: UpdateStatus = isNewerVersion(
      release.version,
      currentVersion,
    )
      ? {
          state: 'available',
          version: release.version,
          releaseUrl: release.url,
          // .deb/.rpm installs go through the OS package manager; there is
          // nothing the in-app updater could download for them (#433).
          canDownload: false,
        }
      : { state: 'idle' }
    this.setStatus(nextStatus)
    return this.status
  }

  /** Runs an initial check and schedules periodic ones. Idempotent. */
  start() {
    if (this.timer !== null) {
      return
    }
    void this.checkNow()
    const setIntervalImpl = this.options.setIntervalImpl ?? defaultSetInterval
    this.timer = setIntervalImpl(() => {
      void this.checkNow()
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

  /** Only emits when the status actually changed, so a no-op daily poll does not repeat IPC pushes/logs forever. */
  private setStatus(status: UpdateStatus) {
    if (statusEquals(this.status, status)) {
      return
    }
    this.status = status
    this.emit('status', status)
  }
}

function statusEquals(a: UpdateStatus, b: UpdateStatus): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
