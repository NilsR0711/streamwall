/**
 * GitHub Releases version checking, shared between streamwall-control-server
 * and streamwall's Linux update checker (#445) — both poll the GitHub
 * Releases API and compare the result against a running version, and
 * previously carried independent copies of this parsing/fetch logic.
 */

const DEFAULT_FETCH_TIMEOUT_MS = 10_000

interface ParsedVersion {
  core: number[]
  prerelease: string[]
}

/**
 * Parses the `MAJOR.MINOR.PATCH[-prerelease]` subset of semver the project
 * actually publishes (`v0.9.1`, `v1.0.0-pre1`). Build metadata is ignored, and
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

export interface LatestRelease {
  version: string
  url: string
}

export type GithubReleaseFetchImpl = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>

/**
 * Fetches the latest published (non-draft, non-prerelease) GitHub release
 * from `url`. Every failure mode — offline host, rate limit, malformed body,
 * hung connection — resolves to null: an update check must never take the
 * caller down with it.
 */
export async function fetchLatestGithubRelease({
  url,
  fetchImpl,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  headers,
}: {
  url: string
  fetchImpl: GithubReleaseFetchImpl
  timeoutMs?: number
  headers?: Record<string, string>
}): Promise<LatestRelease | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: 'application/vnd.github+json', ...headers },
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
