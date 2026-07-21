import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))

function readPackageJson(relativePath) {
  return JSON.parse(readFileSync(join(rootDir, relativePath), 'utf8'))
}

function workspacePackageJsonPaths() {
  const rootPackageJson = readPackageJson('package.json')
  return rootPackageJson.workspaces.map((workspace) =>
    join(workspace, 'package.json'),
  )
}

test('every workspace package.json declares the MIT license', () => {
  const packageJsonPaths = ['package.json', ...workspacePackageJsonPaths()]

  for (const relativePath of packageJsonPaths) {
    const { license } = readPackageJson(relativePath)
    assert.equal(license, 'MIT', `${relativePath} is missing "license": "MIT"`)
  }
})

// Bundlers (Vite) strip types without checking them, so a `build` script alone
// can emit a passing bundle from code that does not typecheck. Binding the
// check to the `prebuild` lifecycle hook means every entry point into a build
// — local, CI, E2E `globalSetup` — pays for it, instead of relying on callers
// to remember a separate `typecheck` run.
test('every workspace that builds typechecks first', () => {
  for (const relativePath of workspacePackageJsonPaths()) {
    const { scripts = {} } = readPackageJson(relativePath)
    if (!scripts.build) {
      continue
    }

    assert.ok(
      scripts.typecheck,
      `${relativePath} has a "build" script but no "typecheck" script`,
    )
    assert.equal(
      scripts.prebuild,
      'npm run typecheck',
      `${relativePath} must run "npm run typecheck" in its "prebuild" script ` +
        'so builds cannot pass with type errors',
    )
  }
})

// The Electron app has no `build` script - it packages through
// electron-forge, whose Vite plugin strips types just as silently. The
// equivalent guarantee lives in a forge `prePackage` hook, which `package`,
// `make` and `publish` all run. Issue #472.
test('every workspace that packages with electron-forge typechecks first', () => {
  for (const relativePath of workspacePackageJsonPaths()) {
    const { scripts = {} } = readPackageJson(relativePath)
    if (
      !Object.values(scripts).some((script) =>
        script.startsWith('electron-forge package'),
      )
    ) {
      continue
    }

    assert.ok(
      scripts.typecheck,
      `${relativePath} packages with electron-forge but has no "typecheck" script`,
    )

    const forgeConfig = readFileSync(
      join(rootDir, dirname(relativePath), 'forge.config.ts'),
      'utf8',
    )
    assert.match(
      forgeConfig,
      /prePackage:[^,]*runTypecheck\(\)/,
      `${dirname(relativePath)}/forge.config.ts must run the typecheck in its ` +
        '"prePackage" hook so packaging cannot pass with type errors',
    )
  }
})

// `--test-timeout` bounds *every* node:test test — including the implicit
// file-level test the runner wraps each file in. A file of live-server
// WebSocket integration tests therefore races the same budget as a single
// test: `wsValidation.test.ts` alone needs 6-13s locally, so the former 20s
// value cancelled the whole file on a loaded machine. A cancelled file reports
// `# fail 0` with a non-zero exit, which reads as an unexplained flake. The
// floor keeps the timeout a hang detector rather than a per-file budget.
// Issue #492.
const NODE_TEST_TIMEOUT_FLOOR_MS = 60_000

test('node:test workspaces leave room for whole-file runtime in --test-timeout', () => {
  for (const relativePath of workspacePackageJsonPaths()) {
    const { scripts = {} } = readPackageJson(relativePath)
    const testScript = scripts.test
    if (!testScript?.includes('--test')) {
      continue
    }

    const configured = testScript.match(/--test-timeout=(\d+)/)
    assert.ok(
      configured,
      `${relativePath} runs node:test without an explicit --test-timeout`,
    )
    assert.ok(
      Number(configured[1]) >= NODE_TEST_TIMEOUT_FLOOR_MS,
      `${relativePath} sets --test-timeout=${configured[1]}, below the ` +
        `${NODE_TEST_TIMEOUT_FLOOR_MS}ms floor that keeps whole test files ` +
        'from being cancelled under load',
    )
  }
})

// The E2E suite deliberately has no `test` script (it needs a browser, so it
// stays out of the `npm test` workspace fan-out), which means the only way to
// discover it is a root-level entry point. Issue #411.
test('the root package exposes the E2E suite as `test:e2e`', () => {
  const { scripts } = readPackageJson('package.json')

  assert.equal(
    scripts['test:e2e'],
    'npm -w streamwall-control-e2e run test:e2e',
    'root package.json is missing a `test:e2e` script delegating to the E2E workspace',
  )
})

test('the E2E workspace defines the delegated `test:e2e` script', () => {
  const { scripts } = readPackageJson(
    'packages/streamwall-control-e2e/package.json',
  )

  assert.ok(
    scripts?.['test:e2e'],
    'streamwall-control-e2e must define the `test:e2e` script the root delegates to',
  )
  assert.equal(
    scripts.test,
    undefined,
    'streamwall-control-e2e must not define `test`: it would join the `npm test` fan-out',
  )
})
