import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  TEST_REPORT_FILE,
  buildEnv,
  countTestCases,
  detectRunner,
  evaluateLeg,
  planLegs,
  runLeg,
} from '../scripts/run-tests.mjs'

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))

// The leg under test must not write to the report the outer `npm test` run is
// using for this very file, whose reporter still holds it open.
const FIXTURE_REPORT_FILE =
  'node_modules/.streamwall-test-report.fixture.junit.xml'

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(rootDir, relativePath), 'utf8'))
}

// Reuses the reporter wiring planLegs produces for the root leg, pointed at a
// fixture instead of the repository's own tests, so these run against the real
// `node --test` rather than a hand-written command line.
function fixtureLeg(pattern) {
  const [rootLeg] = planLegs([])

  return {
    ...rootLeg,
    name: `fixture (${pattern})`,
    args: rootLeg.args.map((arg) =>
      arg === 'test/*.test.mjs'
        ? pattern
        : arg.replace(TEST_REPORT_FILE, FIXTURE_REPORT_FILE),
    ),
    reportPath: FIXTURE_REPORT_FILE,
  }
}

test('detectRunner recognises the two runners this repository uses', () => {
  assert.equal(detectRunner('vitest run'), 'vitest')
  assert.equal(
    detectRunner('node --import tsx --test --test-force-exit "src/**/*.ts"'),
    'node-test',
  )
})

test('detectRunner rejects a runner it cannot count tests for', () => {
  assert.throws(
    () => detectRunner('jest --ci'),
    /jest --ci/,
    'an unknown runner must fail loudly instead of being counted as zero tests',
  )
})

// The wrapper has to know each runner to ask it for a machine-readable report.
// A workspace that switches runners without teaching the wrapper about it would
// otherwise report zero tests and fail the whole suite, so catch it here where
// the message can say why.
test('every workspace test script is a runner the wrapper understands', () => {
  for (const workspace of readJson('package.json').workspaces) {
    const { name, scripts = {} } = readJson(join(workspace, 'package.json'))
    if (!scripts.test) {
      continue
    }
    assert.doesNotThrow(
      () => detectRunner(scripts.test),
      `workspace "${name}" runs its tests with a runner scripts/run-tests.mjs ` +
        'cannot extract a test count from',
    )
  }
})

test('the root test script runs the wrapper rather than the runners directly', () => {
  assert.match(
    readJson('package.json').scripts.test,
    /scripts\/run-tests\.mjs/,
    'bypassing the wrapper would restore the failure mode #678 is about: a ' +
      'suite that runs zero tests looking exactly like one that passed',
  )
})

test('countTestCases counts the cases in a node:test JUnit report', () => {
  const report = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
\t<testsuite name="GET /admin/status" tests="2" failures="0">
\t\t<testcase name="answers" time="0.4" classname="test"/>
\t\t<testcase name="rejects" time="0.1" classname="test"/>
\t</testsuite>
\t<!-- tests 2 -->
</testsuites>`

  assert.equal(countTestCases(report), 2)
})

test('countTestCases counts the cases in a vitest JUnit report', () => {
  const report = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="3" failures="1">
    <testsuite name="src/geometry.test.ts" tests="3">
        <testcase classname="src/geometry.test.ts" name="a" time="0.001" />
        <testcase classname="src/geometry.test.ts" name="b" time="0.002">
            <failure message="expected 1 to be 2">AssertionError</failure>
        </testcase>
        <testcase classname="src/geometry.test.ts" name="c" time="0.003" />
    </testsuite>
</testsuites>`

  assert.equal(countTestCases(report), 3)
})

// A suite that dies at worker startup leaves either no report at all or an
// empty shell of one - which is exactly the case that must not read as success.
test('countTestCases reports zero for a missing or empty report', () => {
  assert.equal(countTestCases(null), 0)
  assert.equal(countTestCases(''), 0)
  assert.equal(
    countTestCases('<?xml version="1.0"?>\n<testsuites></testsuites>'),
    0,
  )
})

test('evaluateLeg accepts a leg that ran tests and exited cleanly', () => {
  const result = evaluateLeg({ name: 'shared' }, { status: 0, testCount: 343 })

  assert.equal(result.ok, true)
  assert.equal(result.testCount, 343)
})

test('evaluateLeg rejects a leg that ran zero tests with a distinct message', () => {
  const result = evaluateLeg(
    { name: 'streamwall-shared' },
    { status: 1, testCount: 0 },
  )

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'no-tests')
  assert.match(result.message, /0 tests executed/)
  assert.match(result.message, /not a test failure/)
  assert.match(result.message, /streamwall-shared/)
})

// The runner crashing before the first assertion is the #671/#675/#676 failure
// mode; a green exit code with nothing executed would be a future workflow bug.
// Both have to end up in the same, unmistakable message.
test('evaluateLeg reports zero tests even when the runner exited successfully', () => {
  const result = evaluateLeg({ name: 'shared' }, { status: 0, testCount: 0 })

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'no-tests')
})

test('evaluateLeg keeps a genuine test failure distinguishable', () => {
  const result = evaluateLeg({ name: 'shared' }, { status: 1, testCount: 343 })

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'failed')
  assert.match(result.message, /343 tests/)
  assert.match(result.message, /exited with 1/)
  assert.doesNotMatch(result.message, /0 tests executed/)
})

test('evaluateLeg reports a leg killed by a signal', () => {
  const result = evaluateLeg(
    { name: 'shared' },
    { status: null, signal: 'SIGKILL', testCount: 12 },
  )

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'failed')
  assert.match(result.message, /SIGKILL/)
})

test('planLegs runs the repository invariants before the workspaces', () => {
  const [first] = planLegs([
    {
      name: 'streamwall-shared',
      dir: 'packages/streamwall-shared',
      runner: 'vitest',
    },
  ])

  assert.match(first.name, /test\//)
  assert.equal(first.command, process.execPath)
  assert.ok(
    first.args.includes('test/*.test.mjs'),
    'the root leg must keep running the repository invariant tests',
  )
  assert.equal(first.reportPath, TEST_REPORT_FILE)
})

test('planLegs asks a vitest workspace for a JUnit report next to its default output', () => {
  const [, leg] = planLegs([
    {
      name: 'streamwall-shared',
      dir: 'packages/streamwall-shared',
      runner: 'vitest',
    },
  ])

  assert.equal(leg.command, 'npm')
  assert.deepEqual(leg.args, [
    'run',
    'test',
    '-w',
    'streamwall-shared',
    '--',
    '--reporter=default',
    '--reporter=junit',
    `--outputFile.junit=${TEST_REPORT_FILE}`,
  ])
  assert.equal(leg.nodeOptions, null)
  assert.equal(
    leg.reportPath,
    join('packages/streamwall-shared', TEST_REPORT_FILE),
    'the report is written relative to the workspace npm runs the script in',
  )
})

// `node --test` only accepts flags before its file arguments, so the reporter
// cannot be appended to the workspace's own test script the way vitest's can.
test('planLegs configures a node:test workspace through NODE_OPTIONS', () => {
  const [, leg] = planLegs([
    {
      name: 'streamwall-control-server',
      dir: 'packages/streamwall-control-server',
      runner: 'node-test',
    },
  ])

  assert.deepEqual(leg.args, ['run', 'test', '-w', 'streamwall-control-server'])
  assert.match(leg.nodeOptions, /--test-reporter=junit/)
  assert.ok(
    leg.nodeOptions.includes(`--test-reporter-destination=${TEST_REPORT_FILE}`),
    'the JUnit reporter needs a destination the wrapper can read back',
  )
  assert.match(
    leg.nodeOptions,
    /--test-reporter=spec/,
    'the human-readable reporter must stay on stdout alongside the JUnit file',
  )
})

// The unit tests above pin the parsing; these two pin the part that can rot
// silently - whether the reporter flags planLegs passes still make a live
// runner produce a report this file can count. If a runner ever changes those
// flags, every leg would report zero tests and the suite would fail everywhere
// at once; this says so in one place instead.
test('runLeg counts the tests of a suite that really ran', () => {
  const result = runLeg(fixtureLeg('test/fixtures/two-passing.test.mjs'), {
    stdio: 'ignore',
  })

  assert.equal(result.ok, true)
  assert.equal(result.testCount, 2)
})

test('runLeg reports a suite that executed nothing as a setup failure', () => {
  const result = runLeg(fixtureLeg('test/fixtures/no-such-file.test.mjs'), {
    stdio: 'ignore',
  })

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'no-tests')
  assert.match(result.message, /0 tests executed/)
})

test('buildEnv appends the leg options to a NODE_OPTIONS the caller already set', () => {
  const env = buildEnv(
    { NODE_OPTIONS: '--max-old-space-size=4096', PATH: '/usr/bin' },
    { nodeOptions: '--test-reporter=junit' },
  )

  assert.equal(
    env.NODE_OPTIONS,
    '--max-old-space-size=4096 --test-reporter=junit',
  )
  assert.equal(env.PATH, '/usr/bin')
})

test('buildEnv drops the node:test context a parent runner would pass down', () => {
  const env = buildEnv(
    { NODE_TEST_CONTEXT: 'child-v8', PATH: '/usr/bin' },
    { nodeOptions: null },
  )

  assert.equal(
    'NODE_TEST_CONTEXT' in env,
    false,
    'a leg inheriting it would silently report to the parent runner instead ' +
      'of writing the JUnit report this wrapper counts',
  )
})

test('buildEnv leaves NODE_OPTIONS untouched for a leg that does not need it', () => {
  const env = buildEnv(
    { NODE_OPTIONS: '--enable-source-maps' },
    {
      nodeOptions: null,
    },
  )

  assert.equal(env.NODE_OPTIONS, '--enable-source-maps')
})
