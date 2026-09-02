import { defineConfig } from 'vitest/config'

// This package needs no special resolve/environment config of its own, but a
// vitest.config.ts still has to exist here: Vitest's config search walks
// *up* from cwd, so without a config of its own `npm run test -w
// streamwall-shared` (cwd = this directory) would otherwise walk up to the
// repo-root `vitest.config.ts` and run every workspace's `test.projects`
// instead of just this package's tests (issue #796).
export default defineConfig({})
