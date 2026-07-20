import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

/**
 * Update *notification* for self-hosted deployments (issue #382).
 *
 * Deliberately notify-only: the server tells the operator that a newer release
 * exists and never touches the running deployment. An unattended in-place
 * self-update would have to rebuild the image and restart the process while
 * holding live uplink/client sockets — far riskier than the desktop app case,
 * and the documented Compose update (`git pull && docker compose up -d
 * --build`, see docs/self-hosting.md) is a single command anyway.
 */

const RELEASES_API_URL =
  'https://api.github.com/repos/NilsR0711/streamwall/releases/latest'

/** Once a day: releases are rare, and this keeps the GitHub API load trivial. */
const DEFAULT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

const DEFAULT_FETCH_TIMEOUT_MS = 10_000

/** Read once at module load: the file cannot change under a running process. */
export const SERVER_VERSION = readServerVersion()

/**
 * The running server's version, read from this package's own manifest. Kept in
 * lockstep with the repo's release tags (see the version-sync test), so it is
 * directly comparable to the `vX.Y.Z` tag of a GitHub release.
 */
function readServerVersion(): string {
  const manifestPath = path.join(import.meta.dirname, '../package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    version?: unknown
  }
  if (typeof manifest.version !== 'string') {
    throw new Error(`Missing "version" in ${manifestPath}`)
  }
  return manifest.version
}

interface ParsedVersion {
  core: number[]
  prerelease: string[]
}

/**
 * Parses the `MAJOR.MINOR.PATCH[-prerelease]` subset of semver we actually
 * publish (`v0.9.1`, `v2.0.0-pre3`). Build metadata is ignored, and anything
 * that does not match returns null so callers can degrade to "no update".
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
  // A version without a prerelease outranks the same core with one (1.0.0 > 1.0.0-pre1).
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

/**
 * The update check reaches out to the GitHub API, so operators who want a
 * fully egress-free deployment can turn it off. Enabled by default; the same
 * off-values as `STREAMWALL_TRUST_PROXY` are honoured for consistency.
 */
export function isUpdateCheckEnabled(raw: string | undefined): boolean {
  if (raw == null || raw.trim() === '') {
    return true
  }
  const v = raw.trim().toLowerCase()
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off')
}

export interface LatestRelease {
  version: string
  url: string
}

type FetchImpl = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<Response>

/**
 * Fetches the latest published (non-draft, non-prerelease) release. Every
 * failure mode — offline host, rate limit, malformed body, hung connection —
 * resolves to null: an update check must never take the server down with it.
 */
export async function fetchLatestRelease({
  fetchImpl = fetch as FetchImpl,
  url = RELEASES_API_URL,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
}: {
  fetchImpl?: FetchImpl
  url?: string
  timeoutMs?: number
} = {}): Promise<LatestRelease | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': `streamwall-control-server/${SERVER_VERSION}`,
      },
    })
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

export interface UpdateStatus {
  /** Version of the running server. */
  version: string
  /** Latest release seen by the most recent successful check, if any. */
  latestVersion: string | null
  updateAvailable: boolean
  releaseUrl: string | null
  /** ISO timestamp of the last *successful* check. */
  lastCheckedAt: string | null
  checkEnabled: boolean
}

export interface UpdateChecker {
  getStatus(): UpdateStatus
  /** Runs a check immediately; resolves with the resulting status. */
  checkNow(): Promise<UpdateStatus>
  /** Runs an initial check and schedules periodic ones. Idempotent. */
  start(): Promise<void>
  stop(): void
}

export interface UpdateCheckerOptions {
  currentVersion?: string
  enabled?: boolean
  intervalMs?: number
  fetchImpl?: FetchImpl
  url?: string
  log?: (message: string) => void
  setIntervalImpl?: (fn: () => void, ms: number) => unknown
  clearIntervalImpl?: (handle: unknown) => void
}

/**
 * Node's `setInterval` handle keeps the event loop alive; unref'ing it means a
 * pending update check never delays process shutdown.
 */
function defaultSetInterval(fn: () => void, ms: number): unknown {
  const handle = setInterval(fn, ms)
  handle.unref?.()
  return handle
}

export function createUpdateChecker({
  currentVersion = SERVER_VERSION,
  enabled = isUpdateCheckEnabled(process.env.STREAMWALL_UPDATE_CHECK),
  intervalMs = DEFAULT_CHECK_INTERVAL_MS,
  fetchImpl,
  url,
  log = console.log,
  setIntervalImpl = defaultSetInterval,
  clearIntervalImpl = (handle) => clearInterval(handle as NodeJS.Timeout),
}: UpdateCheckerOptions = {}): UpdateChecker {
  let latest: LatestRelease | null = null
  let lastCheckedAt: string | null = null
  let announcedVersion: string | null = null
  let timer: unknown = null

  const getStatus = (): UpdateStatus => ({
    version: currentVersion,
    latestVersion: latest?.version ?? null,
    updateAvailable: latest
      ? isNewerVersion(latest.version, currentVersion)
      : false,
    releaseUrl: latest?.url ?? null,
    lastCheckedAt,
    checkEnabled: enabled,
  })

  const checkNow = async (): Promise<UpdateStatus> => {
    if (!enabled) {
      return getStatus()
    }
    const release = await fetchLatestRelease({ fetchImpl, url })
    if (release) {
      latest = release
      lastCheckedAt = new Date().toISOString()
    }
    const status = getStatus()
    // Announce each newer version once, so a daily check does not repeat the
    // same line in the operator's logs forever.
    if (
      status.updateAvailable &&
      status.latestVersion !== null &&
      status.latestVersion !== announcedVersion
    ) {
      announcedVersion = status.latestVersion
      log(
        `⬆️  streamwall-control-server ${status.latestVersion} is available (running ${currentVersion}): ${status.releaseUrl}`,
      )
    }
    return status
  }

  return {
    getStatus,
    checkNow,
    async start() {
      if (!enabled || timer !== null) {
        return
      }
      await checkNow()
      timer = setIntervalImpl(() => {
        void checkNow()
      }, intervalMs)
    },
    stop() {
      if (timer !== null) {
        clearIntervalImpl(timer)
        timer = null
      }
    },
  }
}
