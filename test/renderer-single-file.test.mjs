import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))

// #796: a `packages/streamwall/src/renderer` component test crashed
// (`TypeError: Cannot add property __, object is not extensible` - a frozen
// React element hitting Preact's reconciler) whenever it was run on its own
// with a repo-root-relative path, because Vitest's config search starts at
// `process.cwd()` and walks *up*, never down: with no config at the repo
// root, `packages/streamwall/vitest.config.ts` - and the `react` ->
// `preact/compat` alias it sets up - was never even considered. The fix is
// the root `vitest.config.ts`'s `test.projects` list, which lets that lookup
// still find the right package config no matter where vitest started
// searching from.
//
// This spawns the real CLI rather than asserting on `vitest.config.ts`'s
// shape, because the bug was about which config Vitest actually resolves for
// a given cwd/path combination, not about what the config file contains.
test('a renderer component test passes when run standalone from the repo root', () => {
  const result = spawnSync(
    'npx',
    ['vitest', 'run', 'packages/streamwall/src/renderer/OverlayRoot.test.tsx'],
    {
      cwd: rootDir,
      encoding: 'utf8',
      // npx is only reachable as the `npx.cmd` shim on Windows, which Node
      // refuses to spawn without a shell since the CVE-2024-27980 fix (#586).
      shell: process.platform === 'win32',
    },
  )

  assert.equal(
    result.status,
    0,
    `expected the standalone run to pass; vitest exited ${result.status}\n` +
      `${result.stdout}\n${result.stderr}`,
  )
})
