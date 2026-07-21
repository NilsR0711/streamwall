import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PACKAGE_JSON = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'package.json',
)

/**
 * The suite used to run one file at a time because process-wide env writes made
 * outcomes order-dependent. Those writes are gone: the rate-limit overrides now
 * go through `buildTestApp`'s injected `rateLimit` option or `setEnvForTest`
 * (guarded by `testEnvHygiene.test.ts`), the remaining ones live in files that
 * `node --test` already isolates in their own process, scratch state is
 * `mkdtemp`-scoped, and the live-server specs bind port 0.
 *
 * Running the files in parallel cuts the suite from ~15s to ~4s locally, so the
 * serial flag stays off. If a genuine cross-file dependency turns up, pin the
 * concurrency again — but replace this test with the reason, so the next
 * attempt does not start from scratch.
 */
test('the package test script does not force the suite to run serially', () => {
  const { scripts } = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as {
    scripts: Record<string, string>
  }

  assert.doesNotMatch(
    scripts.test,
    /--test-concurrency[= ]1(?!\d)/,
    'the control-server specs are safe to run in parallel; see the comment above before pinning them again',
  )
})
