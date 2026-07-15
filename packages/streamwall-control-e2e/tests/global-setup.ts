import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Builds the control client once before the suite runs, so the control server
 * has real `dist/` assets to serve. The build is spawned with `NODE_OPTIONS`
 * cleared so the harness's `--import tsx` loader can't interfere with Vite's
 * own config loading.
 */
export default function globalSetup() {
  const clientDir = path.resolve(
    fileURLToPath(new URL('.', import.meta.url)),
    '../../streamwall-control-client',
  )
  execFileSync('npm', ['run', 'build'], {
    cwd: clientDir,
    stdio: 'inherit',
    env: { ...process.env, NODE_OPTIONS: '' },
  })
}
