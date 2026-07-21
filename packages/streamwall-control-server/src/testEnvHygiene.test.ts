import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url))

/** This file — it names the guarded variables and must not flag itself. */
const SELF = path.basename(fileURLToPath(import.meta.url))

/**
 * The process-wide variables the server reads at boot. A bare write to any of
 * them leaks into every file that runs afterwards, making outcomes
 * order-dependent and blocking a higher `--test-concurrency`. Specs pass the
 * value through `buildTestApp` where `initApp` accepts one by injection
 * (`rateLimit`, `docUpdateLimits`), and the ones that must exercise the
 * environment itself go through `setEnvForTest`, which restores the previous
 * value rather than merely unsetting the variable.
 */
const GUARDED_ENV_VARS = [
  'STREAMWALL_RATE_LIMIT_MAX',
  'STREAMWALL_AUTH_RATE_LIMIT_MAX',
  'STREAMWALL_RATE_LIMIT_WINDOW',
  'STREAMWALL_WS_MSG_BURST',
  'STREAMWALL_WS_MSG_RATE',
  'STREAMWALL_WS_UPDATE_MAX_BYTES',
  'STREAMWALL_WS_DOC_GROWTH_MAX_BYTES',
  'STREAMWALL_TRUST_PROXY',
  'STREAMWALL_SENTRY_ENABLED',
  'STREAMWALL_SENTRY_DSN',
  'LOG_LEVEL',
  'DB_PATH',
]

const guardedNames = GUARDED_ENV_VARS.join('|')

/** `process.env.FOO = ...` or `delete process.env.FOO` for a guarded name. */
const FORBIDDEN_DOT_ACCESS = new RegExp(
  `(?:delete\\s+process\\.env\\.(?:${guardedNames})\\b|process\\.env\\.(?:${guardedNames})\\s*=(?!=))`,
)

/**
 * The same writes spelled with a computed key (`process.env[SENTRY_DSN_ENV]`).
 * Guarded names cannot be recognized through the indirection, so any bracketed
 * write is rejected: no spec needs one that `setEnvForTest` cannot express.
 */
const FORBIDDEN_BRACKET_ACCESS =
  /(?:delete\s+process\.env\[|process\.env\[[^\]]*\]\s*=(?!=))/

function testFiles(): string[] {
  return readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })
    .filter(
      (entry) => entry.endsWith('.test.ts') && path.basename(entry) !== SELF,
    )
    .map((entry) => path.join(SRC_DIR, entry))
}

function offendersMatching(pattern: RegExp): string[] {
  return testFiles()
    .filter((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .some((line) => pattern.test(line)),
    )
    .map((file) => path.relative(SRC_DIR, file))
}

test('no spec writes a guarded env var without restoring it', () => {
  assert.deepEqual(
    offendersMatching(FORBIDDEN_DOT_ACCESS),
    [],
    'use an injected buildTestApp option or setEnvForTest() instead of assigning these env vars directly',
  )
})

test('no spec writes process.env through a computed key', () => {
  assert.deepEqual(
    offendersMatching(FORBIDDEN_BRACKET_ACCESS),
    [],
    'setEnvForTest() takes a variable name as a key, so a bracketed write is never needed',
  )
})
