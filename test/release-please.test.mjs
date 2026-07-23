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
  const manifestFiles = rootPackage['extra-files'].filter(
    (file) => file.path !== 'package-lock.json',
  )

  assert.deepEqual(
    manifestFiles.map((file) => file.path),
    RELEASE_TRACKED_WORKSPACES.map((workspace) => `${workspace}/package.json`),
  )
  for (const file of manifestFiles) {
    assert.equal(file.type, 'json')
    assert.equal(file.jsonpath, '$.version')
  }
})

// The `node` release type rewrites the root entries of package-lock.json but
// not the workspace entries `extra-files` bumps, so without these the lock
// keeps the previous version until an unrelated `npm install` rewrites it.
// Issue #513.
test('release-please bumps the workspace entries of package-lock.json', () => {
  const lockFiles = rootPackage['extra-files'].filter(
    (file) => file.path === 'package-lock.json',
  )

  assert.deepEqual(
    lockFiles.map((file) => file.jsonpath),
    RELEASE_TRACKED_WORKSPACES.map(
      (workspace) => `$.packages['${workspace}'].version`,
    ),
  )
  for (const file of lockFiles) {
    assert.equal(file.type, 'json')
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

// A lock entry left behind by a release surfaces as an unrelated diff in some
// later PR, so catch the drift here rather than in an unsuspecting review.
// Issue #513.
test('package-lock.json records the release version for every tracked workspace', () => {
  const lockPackages = readJson('package-lock.json').packages
  const version = readJson('package.json').version

  assert.equal(
    lockPackages[''].version,
    version,
    'the root entry of package-lock.json must stay on the root release version',
  )
  for (const workspace of RELEASE_TRACKED_WORKSPACES) {
    assert.equal(
      lockPackages[workspace].version,
      version,
      `package-lock.json entry "${workspace}" must stay on the root release version`,
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

// The dispatch shim added in #547 was meant to start the required checks for
// the release PR, whose `pull_request` events GitHub never delivers because
// the PR is opened with a workflow's GITHUB_TOKEN. It never worked: a
// workflow_dispatch run reports against the branch head, not the pull
// request, so its checks never entered the PR's status check rollup and
// branch protection still blocked the merge (#578) — while every push to
// `main` paid for an extra full CI matrix, macOS packaging leg included.
// Close/reopen is the step that works; a PAT or GitHub App token (#549)
// would remove the workaround entirely.
test('release-please does not dispatch the required checks (#578)', () => {
  const workflow = readWorkflow('release-please.yml')
  const job = workflow.jobs['release-please']

  assert.equal(
    job.permissions.actions,
    undefined,
    'nothing is dispatched, so the actions scope must stay dropped',
  )
  for (const step of job.steps) {
    assert.doesNotMatch(
      step.run ?? '',
      /gh workflow run/,
      'dispatched runs never attach to the release PR and cannot satisfy branch protection (#578)',
    )
  }
})

// The workflow_dispatch triggers on ci.yml and pr-title.yml existed only for
// that shim (#547). Leaving them behind invites wiring the dispatch back up,
// and pr-title.yml cannot even resolve a title without an event payload. A
// genuine future need for manual runs should revisit #578 first.
test('the required checks are event-driven only (#578)', () => {
  for (const fileName of ['ci.yml', 'pr-title.yml']) {
    assert.ok(
      !('workflow_dispatch' in readWorkflow(fileName).on),
      `${fileName} must not be dispatchable — a dispatched run reports on the branch head, not the PR (#578)`,
    )
  }
})

// This guard used to assert the opposite: that the close/reopen workaround was
// gone, because the dispatch shim added in #547 was expected to make it
// unnecessary. It did not. A workflow_dispatch run reports against the branch
// head rather than the pull request, so its checks never enter the PR's status
// check rollup and branch protection still blocks the merge (#578). Cutting
// v0.10.0 hit exactly that. Until release-please runs with a token that raises
// real pull_request events (#549), close/reopen is the step that works, and the
// documentation has to say so — without describing the removed dispatch as
// part of the release.
test('the release documentation keeps the close/reopen step', () => {
  const contributing = readFileSync(join(rootDir, 'CONTRIBUTING.md'), 'utf8')
  const releasing = contributing.split('#### Releasing')[1]?.split('\n### ')[0]

  assert.ok(releasing, 'CONTRIBUTING.md must keep the "Releasing" walkthrough')
  assert.match(
    releasing,
    /reopen the release PR/i,
    'the release PR only gets its required checks from a real pull_request event (#578)',
  )
  assert.doesNotMatch(
    releasing,
    /dispatch/i,
    'the removed dispatch shim must not be described as a release step (#578)',
  )
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

// release-please refuses to build the next release PR while a merged one still
// carries `autorelease: pending`: it reports "There are untagged, merged
// release PRs outstanding - aborting" and exits successfully, so the workflow
// stays green while every commit on `main` piles up unreleased. The label is
// normally cleared by the GitHub-release step, which this repository skips
// because the tag is pushed by hand — so the tag run has to clear it instead
// (#611).
test('release.yml clears the release PR label that blocks the next release', () => {
  const release = readWorkflow('release.yml')
  const job = release.jobs['release-pr-label']

  assert.ok(job, 'release.yml is missing a release-pr-label job')
  assert.equal(
    job.permissions['pull-requests'],
    'write',
    'relabelling the release PR needs the pull-requests: write scope',
  )
  assert.match(
    job.if ?? '',
    /refs\/tags\/v/,
    'only a tag run knows which release version to relabel',
  )
  assert.ok(
    job.needs.includes('publish'),
    'the label must only move once the tag actually produced a release',
  )

  const run = job.steps.map((step) => step.run ?? '').join('\n')
  assert.match(run, /--add-label\s+'autorelease: tagged'/)
  assert.match(run, /--remove-label\s+'autorelease: pending'/)
  assert.match(
    run,
    /autorelease: pending/,
    'the merged release PR is found by the label release-please left on it',
  )
})
