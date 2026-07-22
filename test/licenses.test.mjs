import { load } from 'js-yaml'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  ALLOWED_LICENSES,
  buildNpmExecOptions,
  collectProductionPackages,
  findLicenseViolations,
  formatViolations,
  isLicenseAllowed,
} from '../scripts/check-licenses.mjs'

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))

// Most fixtures describe the license on the tree node itself; only the
// manifest-precedence test needs a reader.
const noManifest = () => null

function readWorkflow(fileName) {
  return load(
    readFileSync(join(rootDir, '.github/workflows', fileName), 'utf8'),
  )
}

test('the allowlist accepts plain permissive SPDX identifiers', () => {
  for (const license of ['MIT', 'Apache-2.0', 'ISC', 'BSD-3-Clause']) {
    assert.ok(isLicenseAllowed(license), `${license} should be allowed`)
  }
})

test('the allowlist rejects copyleft and unresolvable licenses', () => {
  for (const license of [
    'GPL-3.0-only',
    'AGPL-3.0-or-later',
    'LGPL-2.1',
    'UNLICENSED',
    'SEE LICENSE IN LICENSE.md',
    '',
    null,
    undefined,
  ]) {
    assert.ok(
      !isLicenseAllowed(license),
      `${JSON.stringify(license)} should not be allowed`,
    )
  }
})

// Dual-licensed packages are shipped under whichever branch we pick, so a
// single compatible branch is enough. A conjunction binds us to every branch.
test('SPDX expressions are evaluated branch by branch', () => {
  assert.ok(isLicenseAllowed('(MIT OR GPL-3.0-only)'))
  assert.ok(isLicenseAllowed('MIT AND ISC'))
  assert.ok(isLicenseAllowed('(MIT OR Apache-2.0) AND ISC'))
  assert.ok(!isLicenseAllowed('MIT AND GPL-3.0-only'))
  assert.ok(!isLicenseAllowed('(GPL-3.0-only OR AGPL-3.0-only)'))
})

// A `WITH` exception changes the terms of the underlying license, so it needs
// a human decision rather than an implicit pass from the base identifier.
test('license exceptions are not silently accepted', () => {
  assert.ok(!isLicenseAllowed('Apache-2.0 WITH LLVM-exception'))
})

test('malformed expressions are rejected instead of throwing', () => {
  for (const license of ['(MIT', 'MIT OR', 'AND MIT', '()']) {
    assert.ok(
      !isLicenseAllowed(license),
      `${JSON.stringify(license)} should not be allowed`,
    )
  }
})

test('production packages are collected once per name and version', () => {
  const tree = {
    dependencies: {
      a: {
        version: '1.0.0',
        path: '/repo/node_modules/a',
        license: 'MIT',
        dependencies: {
          b: { version: '2.0.0', path: '/repo/node_modules/b', license: 'ISC' },
        },
      },
      b: { version: '2.0.0', path: '/repo/node_modules/b', license: 'ISC' },
    },
  }

  assert.deepEqual(collectProductionPackages(tree, noManifest), [
    { name: 'a', version: '1.0.0', license: 'MIT' },
    { name: 'b', version: '2.0.0', license: 'ISC' },
  ])
})

// `npm ls` reports unmet optional dependencies (e.g. the platform-specific
// esbuild binaries) as empty nodes, and a working tree can carry leftovers
// from an older install. Neither ends up in a packaged release.
test('uninstalled and extraneous nodes are skipped', () => {
  const tree = {
    dependencies: {
      'unmet-optional': {},
      leftover: {
        version: '1.0.0',
        path: '/repo/node_modules/leftover',
        license: 'GPL-3.0-only',
        extraneous: true,
      },
      real: {
        version: '1.0.0',
        path: '/repo/node_modules/real',
        license: 'MIT',
      },
    },
  }

  assert.deepEqual(collectProductionPackages(tree, noManifest), [
    { name: 'real', version: '1.0.0', license: 'MIT' },
  ])
})

// Old packages predate the SPDX `license` string; npm still surfaces the
// legacy shapes verbatim, and a dropped field must not read as "compatible".
test('legacy license fields are normalized, unknown shapes are not', () => {
  const tree = {
    dependencies: {
      legacyObject: {
        version: '1.0.0',
        path: '/repo/node_modules/legacyObject',
        license: { type: 'MIT', url: 'https://example.test/LICENSE' },
      },
      legacyArray: {
        version: '1.0.0',
        path: '/repo/node_modules/legacyArray',
        licenses: [{ type: 'MIT' }, { type: 'GPL-3.0-only' }],
      },
      unlicensed: {
        version: '1.0.0',
        path: '/repo/node_modules/unlicensed',
      },
    },
  }

  assert.deepEqual(collectProductionPackages(tree, noManifest), [
    { name: 'legacyObject', version: '1.0.0', license: 'MIT' },
    { name: 'legacyArray', version: '1.0.0', license: '(MIT OR GPL-3.0-only)' },
    { name: 'unlicensed', version: '1.0.0', license: null },
  ])
})

// `npm ls --long` expands the manifest fields on the first occurrence of a
// package only; a deduplicated second occurrence can carry nothing but a
// version and a path. Reading the installed manifest keeps that from being
// mistaken for a package without a license.
test('the installed manifest wins over a sparse tree node', () => {
  const tree = {
    dependencies: {
      sparse: { version: '19.0.0', path: '/repo/node_modules/sparse' },
    },
  }

  const readManifest = (path) =>
    path === '/repo/node_modules/sparse' ? { license: 'MIT' } : null

  assert.deepEqual(collectProductionPackages(tree, readManifest), [
    { name: 'sparse', version: '19.0.0', license: 'MIT' },
  ])
})

// An unreadable manifest must not read as "compatible".
test('an unreadable manifest leaves the license unresolved', () => {
  const tree = {
    dependencies: {
      broken: { version: '1.0.0', path: '/repo/node_modules/broken' },
    },
  }

  assert.deepEqual(collectProductionPackages(tree, noManifest), [
    { name: 'broken', version: '1.0.0', license: null },
  ])
})

test('violations name every offending package and its license', () => {
  const violations = findLicenseViolations([
    { name: 'fine', version: '1.0.0', license: 'MIT' },
    { name: 'copyleft', version: '2.3.4', license: 'GPL-3.0-only' },
    { name: 'nameless', version: '0.1.0', license: null },
  ])

  assert.deepEqual(violations, [
    { name: 'copyleft', version: '2.3.4', license: 'GPL-3.0-only' },
    { name: 'nameless', version: '0.1.0', license: null },
  ])

  const report = formatViolations(violations)
  assert.match(report, /copyleft@2\.3\.4/)
  assert.match(report, /GPL-3\.0-only/)
  assert.match(report, /nameless@0\.1\.0/)
  assert.match(report, /no license field/)
})

// On Windows npm is only reachable as the `npm.cmd` shim, which Node refuses
// to spawn without a shell since the CVE-2024-27980 fix (#586).
test('buildNpmExecOptions spawns through a shell on Windows', () => {
  const options = buildNpmExecOptions('win32')
  assert.equal(options.shell, true)
})

test('buildNpmExecOptions does not need a shell elsewhere', () => {
  assert.equal(buildNpmExecOptions('linux').shell, false)
  assert.equal(buildNpmExecOptions('darwin').shell, false)
})

// The check only gates merges while it hangs off the aggregate `CI OK` job,
// and only gates releases while `publish` waits for it.
test('the license check gates both CI and the release workflow', () => {
  const ci = readWorkflow('ci.yml')
  const licenses = ci.jobs.licenses

  assert.ok(licenses, 'ci.yml is missing a licenses job')
  assert.ok(
    licenses.steps.some((step) => step.run?.includes('licenses:check')),
    'the ci.yml licenses job must run the license check script',
  )

  const release = readWorkflow('release.yml')
  assert.ok(release.jobs.licenses, 'release.yml is missing a licenses job')
  assert.ok(
    release.jobs.publish.needs.includes('licenses'),
    'release.yml publish must wait for the licenses job',
  )
})

// Contributors read the policy in CONTRIBUTING, CI enforces the constant.
// If they drift apart, one of them is lying.
test('CONTRIBUTING documents exactly the allowed licenses', () => {
  const contributing = readFileSync(join(rootDir, 'CONTRIBUTING.md'), 'utf8')
  const section = contributing
    .split('### Allowed dependency licenses')[1]
    ?.split(/^#{2,3} /m)[0]

  assert.ok(section, 'CONTRIBUTING.md is missing an allowed licenses section')

  const documented = [...section.matchAll(/^- `([^`]+)`/gm)].map((m) => m[1])

  assert.deepEqual(documented, [...ALLOWED_LICENSES])
})
