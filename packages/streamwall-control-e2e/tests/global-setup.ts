import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Builds the control client once before the suite runs, so the control server
 * has real `dist/` assets to serve. The build is spawned with `NODE_OPTIONS`
 * cleared so the harness's `--import tsx` loader can't interfere with Vite's
 * own config loading.
 *
 * CI sets `STREAMWALL_E2E_SKIP_CLIENT_BUILD=1` and supplies `dist/` from the
 * build job's artifact instead, so a CI run builds the client only once. The
 * assets are verified rather than assumed: a missing `index.html` would
 * otherwise surface as a confusing 404 inside the browser tests.
 */
export default function globalSetup() {
  const clientDir = path.resolve(
    fileURLToPath(new URL('.', import.meta.url)),
    '../../streamwall-control-client',
  )

  if (process.env.STREAMWALL_E2E_SKIP_CLIENT_BUILD === '1') {
    const entry = path.join(clientDir, 'dist/index.html')
    if (!existsSync(entry)) {
      throw new Error(
        `STREAMWALL_E2E_SKIP_CLIENT_BUILD is set but ${entry} is missing. ` +
          'Provide prebuilt control-client assets or unset the flag.',
      )
    }
    return
  }

  execFileSync('npm', ['run', 'build'], {
    cwd: clientDir,
    stdio: 'inherit',
    env: { ...process.env, NODE_OPTIONS: '' },
  })
}
