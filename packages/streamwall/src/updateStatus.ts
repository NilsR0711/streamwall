/**
 * Update lifecycle as surfaced to the control renderer, shared between the
 * main process (which owns the updater) and the sandboxed control preload
 * (which only forwards it), the same way sentryConfig.ts is shared.
 *
 * The shape mirrors what `electron-updater` reports (#432): an update is
 * announced first (`available`), the download only starts on user consent,
 * and `download-progress` events carry byte counts, so `downloading` can show
 * determinate progress. `progress` stays null until the first progress event
 * (and if the backend never reports one), letting the UI fall back to an
 * indeterminate indicator.
 *
 * `available` doubles as Linux's notify-only state (#433): there
 * linuxUpdateChecker.ts polls GitHub Releases directly and can only ever
 * offer a link, never a download, hence `canDownload: false`.
 */
export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | {
      state: 'available'
      version: string
      releaseUrl: string | null
      canDownload: boolean
    }
  | { state: 'downloading'; version: string; progress: DownloadProgress | null }
  | { state: 'ready'; version: string; releaseNotesUrl: string | null }
  | { state: 'error'; message: string }

/** Byte-level progress of an in-flight update download. */
export interface DownloadProgress {
  /** 0-100, as reported by electron-updater. */
  percent: number
  transferred: number
  total: number
}

/**
 * Builds the GitHub release page URL for an update.
 *
 * The updater reports the release version, which is the `v*` tag for releases
 * cut by the forge publisher but is not guaranteed to carry the prefix, so
 * normalize it rather than double-prefixing.
 */
export function releaseNotesUrl(
  repository: string | null,
  version: string,
): string | null {
  if (!repository) {
    return null
  }
  const tag = version.startsWith('v') ? version : `v${version}`
  return `https://github.com/${repository}/releases/tag/${tag}`
}

/**
 * Turns package.json's `github:owner/name` shorthand into the `owner/name`
 * slug release URLs need.
 *
 * Mirrors forge.publisher.ts's parser, but returns null instead of throwing:
 * a missing repository only costs the release-notes link, and must not stop
 * an otherwise installable update from being offered.
 */
export function parseRepositorySlug(
  repository: string | undefined,
): string | null {
  const match = /^github:([^/]+)\/(.+)$/.exec(repository ?? '')
  return match ? `${match[1]}/${match[2]}` : null
}

/** Strips a `v` prefix from a release tag, for display next to `app.getVersion()`. */
export function normalizeVersion(version: string): string {
  return version.startsWith('v') ? version.slice(1) : version
}
