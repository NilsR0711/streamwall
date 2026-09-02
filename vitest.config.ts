import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// No workspace at this level has its own tests; this file exists solely so
// that `vitest` run from the repo root (or given a full `packages/<name>/...`
// path, as an IDE test runner or a copy-pasted file path does) still resolves
// each file's own package config.
//
// Vitest's config search starts at `process.cwd()` and walks *up* the
// directory tree, never down into subdirectories, so
// `npx vitest run packages/streamwall/src/renderer/Foo.test.tsx` run from the
// repo root picked up no config at all: none exists here (until this file),
// and `packages/streamwall/vitest.config.ts` was never even considered. Every
// package-specific `resolve.alias` (`react` -> `preact/compat`, the
// `electron-log/main` redirect) and `deps.inline` entry was silently dropped,
// so the file resolved the real `react` package instead of `preact/compat`
// and crashed Preact's reconciler (`Cannot add property __, object is not
// extensible`) - the exact class of bug `packages/streamwall/vitest.config.ts`
// documents at length for `react-icons`/`styled-components`, just triggered by
// cwd instead of module load order (issue #796).
//
// `npm run test -w <workspace>` (what `scripts/run-tests.mjs` and each
// workspace's own `npm test` use) sets cwd to the workspace directory, so
// those already found their own package's config directly and never needed
// this file - every vitest workspace that has one keeps it, so that lookup
// still finds the nearer, package-specific config first and never reaches
// this one. `streamwall-shared` had no config of its own, which without a
// stub file here would let ITS `npm run test -w streamwall-shared` walk
// straight up to this root config and run every project's tests instead of
// just its own; `packages/streamwall-shared/vitest.config.ts` exists purely
// to stay closer than this file.
//
// `test.projects` makes every listed workspace's config apply to its own
// files regardless of the cwd vitest was invoked from - it does not run their
// suites here, it only lets this root config delegate resolution to them.
// The entries are absolute: this file can be discovered from any cwd via the
// upward search above, and relative project paths resolve against that cwd,
// not against this file's own directory - a nested cwd would otherwise turn
// `packages/streamwall` into a path under itself.
const dirname = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  test: {
    projects: [
      `${dirname}packages/streamwall`,
      `${dirname}packages/streamwall-shared`,
      `${dirname}packages/streamwall-control-client`,
      `${dirname}packages/streamwall-control-ui`,
    ],
  },
})
