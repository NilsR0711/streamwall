import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url))

/**
 * Bare writes to the process-wide rate-limit variables leak into every file
 * that runs afterwards, making outcomes order-dependent and blocking a higher
 * `--test-concurrency`. Specs widen the limits through `buildTestApp`'s
 * injected `rateLimit` option, and the few that must exercise the environment
 * itself go through `setEnvForTest`, which restores the previous values.
 */
const FORBIDDEN_ASSIGNMENT =
  /(?:delete\s+process\.env\.STREAMWALL_(?:AUTH_)?RATE_LIMIT_(?:MAX|WINDOW)|process\.env\.STREAMWALL_(?:AUTH_)?RATE_LIMIT_(?:MAX|WINDOW)\s*=(?!=))/

function testFiles(): string[] {
  return readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.test.ts'))
    .map((entry) => path.join(SRC_DIR, entry))
}

test('no spec writes the rate-limit env vars without restoring them', () => {
  const offenders = testFiles().filter((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .some((line) => FORBIDDEN_ASSIGNMENT.test(line)),
  )

  assert.deepEqual(
    offenders.map((file) => path.relative(SRC_DIR, file)),
    [],
    'use buildTestApp({ rateLimit }) or setEnvForTest() instead of assigning the rate-limit env vars directly',
  )
})
