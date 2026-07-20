import fetch from 'node-fetch'
import EventEmitter from 'node:events'
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

interface ParsedVersion {
  core: number[]
  prerelease: string[]
}

/**
 * Parses the `MAJOR.MINOR.PATCH[-prerelease]` subset of semver the project
 * actually publishes (`v0.9.1`, `v2.0.0-pre3`). Build metadata is ignored, and
 * anything that does not match returns null so callers can degrade to "no
 * update".
 */
function parseVersion(raw: string): ParsedVersion | null {
  const match =
    /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[\w.-]+)?$/.exec(
      raw.trim(),
    )
  if (!match) {
    return null
  }
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

/** Semver precedence for prerelease identifiers: numeric < alphanumeric. */
function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) {
    return a.length === b.length ? 0 : a.length === 0 ? 1 : -1
  }
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i]
    const right = b[i]
    if (left === undefined) {
      return -1
    }
    if (right === undefined) {
      return 1
    }
    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)
    if (leftNumeric && rightNumeric) {
      if (Number(left) !== Number(right)) {
        return Number(left) < Number(right) ? -1 : 1
      }
      continue
    }
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1
    }
    if (left !== right) {
      return left < right ? -1 : 1
    }
  }
  return 0
}

/**
 * True when `candidate` is strictly newer than `current`. Unparsable input on
 * either side yields false: a version we cannot reason about must never
 * produce a bogus "update available" notice.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate)
  const b = parseVersion(current)
  if (!a || !b) {
    return false
  }
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) {
      return a.core[i] > b.core[i]
    }
  }
  return comparePrerelease(a.prerelease, b.prerelease) > 0
}

interface LatestRelease {
  version: string
  url: string
}

type FetchResponse = {
  ok: boolean
  json(): Promise<unknown>
}

type FetchImpl = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<FetchResponse>

/**
 * Fetches the latest published (non-draft, non-prerelease) release. Every
 * failure mode - offline host, rate limit, malformed body, hung connection -
 * resolves to null: an update notice must never come from data that could not
 * be fully verified.
 */
async function fetchLatestRelease(
  repository: string,
  fetchImpl: FetchImpl,
  timeoutMs: number,
): Promise<LatestRelease | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(
      `https://api.github.com/repos/${repository}/releases/latest`,
      {
        signal: controller.signal,
        headers: { accept: 'application/vnd.github+json' },
      },
    )
    if (!response.ok) {
      return null
    }
    const body = (await response.json()) as {
      tag_name?: unknown
      html_url?: unknown
      draft?: unknown
      prerelease?: unknown
    }
    if (body.draft === true || body.prerelease === true) {
      return null
    }
    if (
      typeof body.tag_name !== 'string' ||
      typeof body.html_url !== 'string'
    ) {
      return null
    }
    return {
      version: body.tag_name.replace(/^v/, ''),
      url: body.html_url,
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export interface LinuxUpdateCheckerEventMap {
  status: [UpdateStatus]
}

export interface LinuxUpdateCheckerOptions {
  currentVersion: string
  /** `owner/name` slug; a check is a no-op when this is unknown. */
  repository: string | null
  fetchImpl?: FetchImpl
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
    const release = await fetchLatestRelease(
      repository,
      this.options.fetchImpl ?? (fetch as unknown as FetchImpl),
      this.options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
    )
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
