/**
 * Update lifecycle as surfaced to the control renderer, shared between the
 * main process (which owns the updater) and the sandboxed control preload
 * (which only forwards it), the same way sentryConfig.ts is shared.
 *
 * The shape deliberately mirrors what Electron's built-in `autoUpdater`
 * (Squirrel) actually reports: it starts downloading as soon as an update is
 * found, and emits no byte-level progress. So `downloading` carries no
 * percentage and there is no separate user-triggered download step - see
 * appUpdater.ts for the full rationale.
 */
export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'downloading' }
  | { state: 'ready'; version: string; releaseNotesUrl: string | null }
  | { state: 'error'; message: string }

/**
 * Builds the GitHub release page URL for a downloaded update.
 *
 * Squirrel reports the release name, which is the `v*` tag for releases cut by
 * the forge publisher but is not guaranteed to carry the prefix, so normalize
 * it rather than double-prefixing.
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

/** Strips the `v` prefix Squirrel may include, for display next to `app.getVersion()`. */
export function normalizeVersion(version: string): string {
  return version.startsWith('v') ? version.slice(1) : version
}
