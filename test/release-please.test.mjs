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

// A pull request opened with a workflow's GITHUB_TOKEN raises no
// `pull_request` events, so the release PR arrives without the two checks
// branch protection requires. `workflow_dispatch` is the one event GitHub
// still delivers for that token, so release-please starts both checks itself
// instead of a maintainer closing and reopening the PR by hand (#521).
test('release-please starts the required checks on the release PR', () => {
  const workflow = readWorkflow('release-please.yml')
  const job = workflow.jobs['release-please']

  assert.equal(
    job.permissions.actions,
    'write',
    'dispatching a workflow run needs the actions: write scope',
  )

  const action = job.steps.find((candidate) =>
    candidate.uses?.startsWith('googleapis/release-please-action@'),
  )
  assert.ok(action.id, 'the release-please step must expose its outputs via id')

  const dispatch = job.steps.find((candidate) =>
    candidate.run?.includes('gh workflow run'),
  )
  assert.ok(
    dispatch,
    'release-please.yml must dispatch the required checks for the release PR',
  )
  assert.match(
    dispatch.if ?? '',
    new RegExp(`steps\\.${action.id}\\.outputs\\.pr`),
    'the dispatch must be skipped on pushes that leave no release PR',
  )
  for (const required of ['ci.yml', 'pr-title.yml']) {
    assert.match(
      dispatch.run,
      new RegExp(`gh workflow run ${required.replace('.', '\\.')}`),
      `${required} produces a required check and must be dispatched`,
    )
  }
  assert.match(
    dispatch.run,
    /--ref/,
    'the checks must run against the release branch, not the default branch',
  )
})

// Both workflows are dispatched by name from release-please.yml; without the
// trigger the dispatch fails and the release PR stays unmergeable.
test('the required checks can be dispatched for the release branch', () => {
  for (const fileName of ['ci.yml', 'pr-title.yml']) {
    assert.ok(
      'workflow_dispatch' in readWorkflow(fileName).on,
      `${fileName} must be dispatchable so the release PR can run it`,
    )
  }
})

// A dispatched run carries no pull request payload, so the check has to look
// the title up from the number it was dispatched with.
test('the PR title check resolves the title of a dispatched release PR', () => {
  const workflow = readWorkflow('pr-title.yml')
  const input = workflow.on.workflow_dispatch?.inputs?.['pr-number']

  assert.ok(input, 'pr-title.yml must accept the PR number as a dispatch input')
  assert.equal(input.required, true)

  const job = workflow.jobs['conventional-title']
  assert.equal(
    job.permissions['pull-requests'],
    'read',
    'reading the title of a dispatched PR needs the pull-requests: read scope',
  )

  const step = job.steps.find((candidate) => candidate.run?.includes('regex='))
  assert.match(
    step.run,
    /gh pr view/,
    'the dispatched run must fetch the title it cannot read from the event',
  )
  assert.equal(step.env.PR_NUMBER, '${{ inputs.pr-number }}')
})

// This guard used to assert the opposite: that the close/reopen workaround was
// gone, because the dispatch shim added in #547 was expected to make it
// unnecessary. It does not. A workflow_dispatch run reports against the branch
// head rather than the pull request, so its checks never enter the PR's status
// check rollup and branch protection still blocks the merge (#578). Cutting
// v0.10.0 hit exactly that. Until release-please runs with a token that raises
// real pull_request events (#549), close/reopen is the step that works, and the
// documentation has to say so.
test('the release documentation keeps the close/reopen step', () => {
  const contributing = readFileSync(join(rootDir, 'CONTRIBUTING.md'), 'utf8')

  assert.match(
    contributing,
    /reopen the release PR/i,
    'the release PR only gets its required checks from a real pull_request event (#578)',
  )
  assert.match(
    contributing,
    /smoke signal/i,
    'the dispatched runs must not be presented as satisfying branch protection (#578)',
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
