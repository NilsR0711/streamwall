import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Keeps every packaging run's staging directory to itself (#510).
 *
 * @electron/packager stages the app under `<tmpdir>/electron-packager` and
 * deletes that entire base directory when a run starts, so two runs on the
 * same machine - a second worktree, a `make` next to a `package` - wipe each
 * other's staging tree mid-run. The victim fails once the fuses plugin
 * re-signs the app it can no longer find ("Ad-hoc codesign failed with status:
 * 1"), which reads like a macOS signing problem but is a plain temp-directory
 * collision. Pointing `packagerConfig.tmpdir` at a fresh directory per run
 * keeps that wipe private to the run performing it.
 */

export const PACKAGING_TMPDIR_PREFIX = 'streamwall-packager-'

/** Creates the base directory a single packaging run stages in. */
export function createPackagingTmpdir(): string {
  return mkdtempSync(path.join(os.tmpdir(), PACKAGING_TMPDIR_PREFIX))
}

/**
 * Removes a directory created by {@link createPackagingTmpdir}. The prefix
 * check keeps a recursive delete from ever reaching a directory this module
 * did not create.
 */
export function removePackagingTmpdir(dir: string): void {
  if (!path.basename(dir).startsWith(PACKAGING_TMPDIR_PREFIX)) {
    throw new Error(`Refusing to remove ${dir}: not a packaging temp directory`)
  }

  rmSync(dir, { recursive: true, force: true })
}

/**
 * Best-effort safety net for a packaging run that never reaches its own
 * cleanup (#749): forge only calls `postPackage` after the whole packaging
 * step *succeeds*, so a run that fails partway through - after this module
 * already staged a tmpdir - would otherwise strand it. `@electron-forge/cli`
 * responds to that kind of failure by calling `process.exit(1)`, which fires
 * 'exit' listeners synchronously before the process actually goes away, so
 * removing the directory there catches what the normal `postPackage` path
 * misses.
 *
 * Call the returned function once the caller performs its own explicit
 * cleanup, so this fallback does not also fire (harmlessly, since removal is
 * idempotent, but needlessly) on every ordinary successful run.
 */
export function registerPackagingTmpdirFallbackCleanup(
  dir: string,
): () => void {
  const cleanup = () => removePackagingTmpdir(dir)
  process.once('exit', cleanup)
  return () => {
    process.removeListener('exit', cleanup)
  }
}
