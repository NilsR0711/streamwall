import {
  spawnSync,
  type SpawnSyncOptions,
  type SpawnSyncReturns,
} from 'node:child_process'

/**
 * Runs this package's `typecheck` script as part of packaging (#472).
 *
 * Forge builds the main, preload and renderer bundles with Vite, which strips
 * types without checking them - so `electron-forge package`/`make`/`publish`
 * would happily emit a release artifact from code that does not compile. The
 * other workspaces bind `npm run typecheck` to npm's `prebuild` hook, but this
 * package has no `build` script; wiring it into forge's `prePackage` hook
 * instead covers all three commands at once, because make and publish both run
 * the package step.
 */

export type SpawnSync = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions,
) => SpawnSyncReturns<Buffer>

export function runTypecheck(
  spawn: SpawnSync = spawnSync,
  platform: NodeJS.Platform = process.platform,
): void {
  // On Windows npm is only reachable as the `npm.cmd` shim: `spawnSync`
  // without a shell resolves executables only (bare `npm` fails with ENOENT),
  // and since the CVE-2024-27980 fix Node refuses to spawn a `.cmd` directly
  // (EINVAL). Both abort packaging, so that platform goes through a shell
  // (#586). The command line is a fixed literal, so nothing is interpolated
  // into it.
  const result = spawn('npm', ['run', 'typecheck'], {
    shell: platform === 'win32',
    // Forge runs hooks from the directory it was invoked in, which is not
    // necessarily this package (a root-level `npm -w streamwall run make`
    // starts elsewhere), so anchor the check to this file's package.
    cwd: import.meta.dirname,
    stdio: 'inherit',
  })

  if (result.error) {
    throw result.error
  }
  if (result.signal) {
    throw new Error(`Typecheck failed: npm run typecheck got ${result.signal}`)
  }
  if (result.status !== 0) {
    throw new Error(
      `Typecheck failed: npm run typecheck exited with ${result.status}`,
    )
  }
}
