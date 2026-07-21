import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))

const workflow = readFileSync(
  join(rootDir, '.github/workflows/packaging.yml'),
  'utf8',
)

test('the packaging workflow runs the makers outside of a release', () => {
  assert.match(
    workflow,
    /^\s*schedule:$/m,
    'the workflow must run on a schedule so maker regressions surface without a tag',
  )
  assert.match(
    workflow,
    /^\s*workflow_dispatch:$/m,
    'the workflow must be manually dispatchable',
  )
  assert.doesNotMatch(
    workflow,
    /run: npm -w streamwall run publish/,
    'the workflow must never publish a release',
  )
  assert.match(
    workflow,
    /run: npm -w streamwall run make/,
    'the workflow must invoke electron-forge make',
  )
})

test('the packaging workflow covers every publish platform', () => {
  for (const os of ['ubuntu-latest', 'windows-latest', 'macos-latest']) {
    assert.match(
      workflow,
      new RegExp(`os: ${os} `),
      `the maker matrix must include ${os}`,
    )
  }
  assert.match(
    workflow,
    /fail-fast: false/,
    'one failing platform must not hide the others',
  )
})

test('the Linux leg installs the tooling the deb and rpm makers need', () => {
  // ubuntu-latest ships dpkg but neither rpmbuild nor fakeroot, so
  // @electron-forge/maker-rpm and maker-deb would fail on the runner.
  assert.match(workflow, /\brpm\b/, 'the rpm maker needs rpmbuild installed')
  assert.match(workflow, /\bfakeroot\b/, 'the deb maker needs fakeroot')
})

test('maker output and logs are retained for diagnosis', () => {
  assert.match(
    workflow,
    /uses: actions\/upload-artifact@[0-9a-f]{40} #/,
    'maker output must be uploaded as a pinned-action artifact',
  )
  assert.match(
    workflow,
    /DEBUG:/,
    'a dispatch must be able to request verbose Forge logs',
  )
})
