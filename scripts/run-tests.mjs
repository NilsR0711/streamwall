#!/usr/bin/env node
// Runs every test suite in the repository and fails loudly when one of them
// reported zero tests (#678).
//
// The `Test` job used to be a plain `npm test`, so it had exactly one signal:
// the exit code. That made a runtime failure look like a test failure. When the
// find-my-way bump in #670 dropped `happy-dom` from the install, all three OS
// legs died at vitest worker startup with `Cannot find package 'happy-dom'`
// before a single assertion ran (#671/#675) - the same red check a broken
// assertion produces, which is slow to tell apart at a glance. The inverse is
// worse: a future config change (`--passWithNoTests`, a glob that matches
// nothing, a workspace silently skipped) could make a suite that executes
// nothing exit zero and be reported as success.
//
// So every suite is asked for a machine-readable JUnit report in addition to
// its usual output, and a leg whose report contains no test case fails with a
// message that names the cause instead of blaming the tests.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))

// Written per leg, always relative to the directory the runner executes in, so
// that no absolute path (with its platform-specific separators and possible
// spaces) has to survive a trip through NODE_OPTIONS on Windows. `node_modules`
// keeps the report out of git and out of Prettier's way.
export const TEST_REPORT_FILE = 'node_modules/.streamwall-test-report.junit.xml'

// The reporter both runners write the count into. JUnit rather than each
// runner's own JSON: node:test has no JSON reporter, and this way a single
// parser covers every leg.
const NODE_TEST_REPORTER_FLAGS = [
  // Keep a readable log next to the machine-readable report. Without an
  // explicit reporter node:test would fall back to `tap` whenever CI's stdout
  // is not a TTY.
  '--test-reporter=spec',
  '--test-reporter-destination=stdout',
  '--test-reporter=junit',
  `--test-reporter-destination=${TEST_REPORT_FILE}`,
]

const VITEST_REPORTER_FLAGS = [
  '--reporter=default',
  '--reporter=junit',
  `--outputFile.junit=${TEST_REPORT_FILE}`,
]

/**
 * Classifies a workspace `test` script by the runner it invokes. Only runners
 * this file knows how to get a test count out of are accepted; anything else
 * throws, because silently running it would produce a report-less leg that
 * looks identical to a suite that executed nothing.
 */
export function detectRunner(testScript) {
  if (/(^|\s)vitest(\s|$)/.test(testScript)) {
    return 'vitest'
  }
  if (/(^|\s)--test(\s|$)/.test(testScript)) {
    return 'node-test'
  }
  throw new Error(
    `Cannot determine the test runner of "${testScript}". scripts/run-tests.mjs ` +
      'has to ask each runner for a JUnit report to verify that tests actually ' +
      'ran, so teach it about this runner before wiring it up (#678).',
  )
}

/**
 * Builds the ordered list of test legs: the repository invariant tests in
 * `test/` first (they are the cheapest and guard the setup itself), then one
 * leg per workspace that has a `test` script.
 */
export function planLegs(workspaces) {
  const legs = [
    {
      name: 'test/ (repository invariants)',
      command: process.execPath,
      args: ['--test', ...NODE_TEST_REPORTER_FLAGS, 'test/*.test.mjs'],
      nodeOptions: null,
      reportPath: TEST_REPORT_FILE,
    },
  ]

  for (const { name, dir, runner } of workspaces) {
    legs.push({
      name,
      command: 'npm',
      args:
        runner === 'vitest'
          ? ['run', 'test', '-w', name, '--', ...VITEST_REPORTER_FLAGS]
          : ['run', 'test', '-w', name],
      // `node --test` only reads flags that precede its file arguments, so a
      // node:test workspace cannot take the reporter through `npm run -- …`
      // the way vitest does; NODE_OPTIONS reaches it either way.
      nodeOptions:
        runner === 'vitest' ? null : NODE_TEST_REPORTER_FLAGS.join(' '),
      reportPath: join(dir, TEST_REPORT_FILE),
    })
  }

  return legs
}

/**
 * Environment for one leg: the caller's, with the leg's extra NODE_OPTIONS
 * merged into any the caller already set rather than replacing them.
 */
export function buildEnv(baseEnv, leg) {
  const env = { ...baseEnv }

  // A `node --test` process that inherits this reports its results back to the
  // parent runner over IPC and ignores `--test-reporter` entirely, so the leg
  // would write no report and be counted as zero tests. It is only ever set
  // when something already running under node:test shells out to `npm test`.
  delete env.NODE_TEST_CONTEXT

  if (leg.nodeOptions) {
    env.NODE_OPTIONS = [baseEnv.NODE_OPTIONS, leg.nodeOptions]
      .filter(Boolean)
      .join(' ')
  }

  return env
}

/** Number of `<testcase>` elements a JUnit report contains. */
export function countTestCases(report) {
  if (!report) {
    return 0
  }
  return report.match(/<testcase[\s/>]/g)?.length ?? 0
}

export function evaluateLeg(leg, { status, signal = null, testCount }) {
  if (testCount === 0) {
    return {
      ok: false,
      reason: 'no-tests',
      message:
        `${leg.name}: 0 tests executed - this is a runtime/setup failure, ` +
        'not a test failure. The runner produced no JUnit report, so it never ' +
        'got as far as an assertion: look for a module resolution, config or ' +
        'transform error above (#676 was one such instance).',
    }
  }

  if (status !== 0) {
    return {
      ok: false,
      reason: 'failed',
      message:
        `${leg.name}: ${testCount} tests ran and the runner ` +
        (signal ? `was killed by ${signal}.` : `exited with ${status}.`),
    }
  }

  return { ok: true, testCount }
}

function readWorkspaces() {
  const { workspaces } = JSON.parse(
    readFileSync(join(rootDir, 'package.json'), 'utf8'),
  )

  return workspaces
    .map((dir) => ({
      dir,
      manifest: JSON.parse(
        readFileSync(join(rootDir, dir, 'package.json'), 'utf8'),
      ),
    }))
    .filter(({ manifest }) => manifest.scripts?.test)
    .map(({ dir, manifest }) => ({
      name: manifest.name,
      dir,
      runner: detectRunner(manifest.scripts.test),
    }))
}

/**
 * Runs one leg to completion and judges it. The report is read from disk after
 * the runner exited, so a runner that died before writing one counts as zero
 * tests - which is the whole point of this file.
 */
export function runLeg(leg, { stdio = 'inherit' } = {}) {
  const reportPath = join(rootDir, leg.reportPath)
  // A stale report from an earlier run would otherwise be credited to a leg
  // that crashed before writing its own.
  rmSync(reportPath, { force: true })
  mkdirSync(dirname(reportPath), { recursive: true })

  const result = spawnSync(leg.command, leg.args, {
    cwd: rootDir,
    stdio,
    env: buildEnv(process.env, leg),
    // On Windows npm is only reachable as the `npm.cmd` shim, which Node
    // refuses to spawn without a shell since the CVE-2024-27980 fix (#586).
    // Every argument is a fixed literal or a workspace name from package.json.
    shell: leg.command === 'npm' && process.platform === 'win32',
  })

  if (result.error) {
    throw result.error
  }

  let report = null
  try {
    report = readFileSync(reportPath, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error
    }
  }
  rmSync(reportPath, { force: true })

  return evaluateLeg(leg, {
    status: result.status,
    signal: result.signal,
    testCount: countTestCases(report),
  })
}

function main() {
  const legs = planLegs(readWorkspaces())
  const counts = []

  for (const leg of legs) {
    const result = runLeg(leg)
    if (!result.ok) {
      console.error(`\n✖ ${result.message}`)
      process.exit(1)
    }
    counts.push({ name: leg.name, testCount: result.testCount })
  }

  const total = counts.reduce((sum, { testCount }) => sum + testCount, 0)
  console.log(`\n✔ ${total} tests executed across ${legs.length} suites:`)
  for (const { name, testCount } of counts) {
    console.log(`  - ${name}: ${testCount}`)
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
