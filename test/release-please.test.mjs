import { load } from 'js-yaml'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { RELEASE_TRACKED_WORKSPACES } from '../scripts/release-version.mjs'

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(rootDir, relativePath), 'utf8'))
}

function readWorkflow(fileName) {
  return load(
    readFileSync(join(rootDir, '.github/workflows', fileName), 'utf8'),
  )
}

const config = readJson('release-please-config.json')
const rootPackage = config.packages['.']

test('release-please releases the repository root as a single component', () => {
  assert.deepEqual(Object.keys(config.packages), ['.'])
  assert.equal(config['release-type'], 'node')
  assert.equal(config['changelog-path'], 'CHANGELOG.md')
})

// The `vX.Y.Z` tag is what `release.yml` triggers on, and what the control
// server compares its own version against. A component prefix ("streamwall-v…")
// would silently take the release line out of that loop.
test('release-please tags releases as vX.Y.Z', () => {
  assert.equal(config['include-component-in-tag'], false)
  assert.equal(config['include-v-in-tag'], true)
})

// Pre-1.0 the project ships features as patch bumps (0.9.0 → 0.9.1); leaving
// the release-please defaults on would turn every `feat:` into a minor bump.
test('release-please keeps the pre-1.0 bump strategy', () => {
  assert.equal(config['bump-minor-pre-major'], true)
  assert.equal(config['bump-patch-for-minor-pre-major'], true)
})

// Only the release-tracking workspaces may be bumped: the other manifests are
// deliberately pinned (see CONTRIBUTING "Cutting a release").
test('release-please bumps exactly the release-tracked manifests', () => {
  const extraFiles = rootPackage['extra-files']

  assert.deepEqual(
    extraFiles.map((file) => file.path),
    RELEASE_TRACKED_WORKSPACES.map((workspace) => `${workspace}/package.json`),
  )
  for (const file of extraFiles) {
    assert.equal(file.type, 'json')
    assert.equal(file.jsonpath, '$.version')
  }
})

// release-please reads the current version from its manifest rather than from
// package.json, so a drift there releases the wrong version number.
test('the release-please manifest matches every release-tracked version', () => {
  const manifest = readJson('.release-please-manifest.json')
  const version = readJson('package.json').version

  assert.deepEqual(Object.keys(manifest), ['.'])
  assert.equal(
    manifest['.'],
    version,
    '.release-please-manifest.json must track the root package.json version',
  )
  for (const workspace of RELEASE_TRACKED_WORKSPACES) {
    assert.equal(
      readJson(`${workspace}/package.json`).version,
      version,
      `${workspace}/package.json must stay on the root release version`,
    )
  }
})

test('the release-please workflow maintains the release PR on main', () => {
  const workflow = readWorkflow('release-please.yml')

  assert.deepEqual(workflow.on.push.branches, ['main'])
  const job = workflow.jobs['release-please']
  assert.equal(job.permissions.contents, 'write')
  assert.equal(job.permissions['pull-requests'], 'write')

  const step = job.steps.find((candidate) =>
    candidate.uses?.startsWith('googleapis/release-please-action@'),
  )
  assert.ok(
    step,
    'release-please.yml must run googleapis/release-please-action',
  )
  assert.match(
    step.uses,
    /@[0-9a-f]{40}$/,
    'actions must be pinned to a commit SHA',
  )
  assert.equal(step.with['config-file'], 'release-please-config.json')
  assert.equal(step.with['manifest-file'], '.release-please-manifest.json')
  // A tag pushed by GITHUB_TOKEN does not trigger `release.yml`, so the tag
  // stays a manual step and release-please must not create it.
  assert.equal(step.with['skip-github-release'], true)
})

test('release.yml turns the changelog section into the release notes', () => {
  const release = readWorkflow('release.yml')
  const job = release.jobs['release-notes']

  assert.ok(job, 'release.yml is missing a release-notes job')
  assert.ok(
    job.needs.includes('publish'),
    'release notes must be written after the publish matrix created the release',
  )
  assert.equal(job.permissions.contents, 'write')
  assert.match(
    job.steps.map((step) => step.run ?? '').join('\n'),
    /scripts\/changelog-section\.mjs/,
  )
})
