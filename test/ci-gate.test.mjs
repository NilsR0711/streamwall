import { load } from 'js-yaml'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))

function readWorkflow(fileName) {
  return load(
    readFileSync(join(rootDir, '.github/workflows', fileName), 'utf8'),
  )
}

function readDoc(relativePath) {
  return readFileSync(join(rootDir, relativePath), 'utf8')
}

// Branch protection requires a single aggregate check per workflow, so any job
// that is not wired into `ci-ok` silently stops gating merges.
test('the ci-ok gate depends on every other job in ci.yml', () => {
  const ci = readWorkflow('ci.yml')
  const gate = ci.jobs['ci-ok']
  const otherJobs = Object.keys(ci.jobs).filter((job) => job !== 'ci-ok')

  for (const job of otherJobs) {
    assert.ok(
      gate.needs.includes(job),
      `ci.yml job "${job}" is missing from the ci-ok gate's needs`,
    )
  }
})

test('CodeQL runs inside ci.yml so its failures block the merge gate', () => {
  const ci = readWorkflow('ci.yml')
  const codeql = ci.jobs.codeql

  assert.ok(codeql, 'ci.yml is missing a codeql job')
  assert.equal(codeql.uses, './.github/workflows/codeql.yml')
})

test('codeql.yml is reusable and does not run standalone on pull requests', () => {
  const triggers = Object.keys(readWorkflow('codeql.yml').on)

  assert.ok(
    triggers.includes('workflow_call'),
    'codeql.yml must be callable from ci.yml',
  )
  assert.ok(
    !triggers.includes('pull_request'),
    'codeql.yml must not also trigger on pull_request, which would run the ' +
      'analysis twice and outside the ci-ok gate',
  )
})

// The control client is expensive to build, and the E2E job needs exactly the
// artifact the build job already produced. Handing it over keeps CI down to a
// single `vite build` per run (issue #489).
test('the E2E job reuses the build job artifact instead of rebuilding', () => {
  const ci = readWorkflow('ci.yml')
  const distPath = 'packages/streamwall-control-client/dist'

  const upload = ci.jobs.build.steps.find((step) =>
    step.uses?.startsWith('actions/upload-artifact@'),
  )
  assert.ok(upload, 'the build job must upload the control-client dist')
  assert.equal(upload.with.path, distPath)
  assert.equal(
    upload.with['if-no-files-found'],
    'error',
    'an empty upload would hand the E2E job nothing to serve',
  )

  assert.ok(
    ci.jobs.e2e.needs.includes('build'),
    'the E2E job must wait for the build job that produces its assets',
  )

  const download = ci.jobs.e2e.steps.find((step) =>
    step.uses?.startsWith('actions/download-artifact@'),
  )
  assert.ok(download, 'the E2E job must download the control-client dist')
  assert.equal(download.with.name, upload.with.name)
  assert.equal(download.with.path, distPath)
})

// The E2E job only gets to skip its own build because the downloaded artifact
// is already in place; the opt-out is an env var so local runs keep building.
test('the E2E global setup honors the skip flag the E2E job sets', () => {
  const ci = readWorkflow('ci.yml')
  const runStep = ci.jobs.e2e.steps.find((step) =>
    step.run?.includes('npm run test:e2e'),
  )

  assert.ok(runStep, 'the E2E job must run the E2E suite')
  const flags = Object.keys(runStep.env ?? {})
  assert.equal(
    flags.length,
    1,
    'expected exactly one env flag on the E2E run step',
  )
  const [flag] = flags
  assert.equal(runStep.env[flag], '1')

  const globalSetup = readDoc(
    'packages/streamwall-control-e2e/tests/global-setup.ts',
  )
  assert.ok(
    globalSetup.includes(flag),
    `global-setup.ts must read the ${flag} flag the workflow sets`,
  )
})

// The documented list is what contributors and maintainers configure branch
// protection from, so it has to name the checks the workflows actually report.
test('CONTRIBUTING documents exactly the required status checks', () => {
  const contributing = readDoc('CONTRIBUTING.md')
  const section = contributing
    .split('### Required status checks')[1]
    ?.split(/^#{2,3} /m)[0]

  assert.ok(
    section,
    'CONTRIBUTING.md is missing a required status checks section',
  )

  const documented = [...section.matchAll(/^- `([^`]+)`/gm)].map((m) => m[1])
  const expected = [
    readWorkflow('ci.yml').jobs['ci-ok'].name,
    readWorkflow('pr-title.yml').jobs['conventional-title'].name,
  ]

  assert.deepEqual(documented, expected)
})

// A maker regression must fail before the first artifact is published: once
// the publish matrix has started, a failing leg leaves a partially populated
// GitHub release behind and the tag has to be redone (#453).
test('the release quality gate makes installers before publishing', () => {
  const release = readWorkflow('release.yml')
  const gateJobs = Object.entries(release.jobs).filter(
    ([job]) => job !== 'publish',
  )
  const runScripts = (job) => job.steps.map((step) => step.run ?? '').join('\n')

  const makeJobs = gateJobs.filter(([, job]) =>
    /npm -w streamwall run make\b/.test(runScripts(job)),
  )
  assert.ok(
    makeJobs.length > 0,
    'release.yml must run `npm -w streamwall run make` before the publish ' +
      'matrix, otherwise a maker or postMake regression first surfaces ' +
      'mid-release',
  )

  for (const [name] of makeJobs) {
    assert.ok(
      release.jobs.publish.needs.includes(name),
      `release.yml job "${name}" is not in the publish job's needs, so it ` +
        'cannot gate the release',
    )
  }

  // The NSIS maker and the latest.yml postMake hook only run for win32, and
  // electron-builder bundles makensis for every host OS, so the gate
  // cross-builds that target instead of trusting the Windows publish leg.
  assert.ok(
    makeJobs.some(([, job]) => /--platform=win32/.test(runScripts(job))),
    'release.yml must cross-build the win32 target so the NSIS maker and ' +
      'the update-metadata hook are exercised before publishing',
  )
})

// MakerZIP is darwin-only and cannot be cross-built from Linux, so a
// Linux-only gate leaves the macOS zip and the latest-mac.yml half of the
// postMake hook to run for the first time inside the publish matrix — the
// exact half-published release the gate exists to prevent (#517).
test('the release quality gate makes the darwin artifacts on a macOS leg', () => {
  const make = readWorkflow('release.yml').jobs.make
  const legs = make.strategy?.matrix?.leg

  assert.ok(
    Array.isArray(legs),
    'the make gate must fan out over a `leg` matrix so the darwin makers ' +
      'get a macOS runner of their own',
  )

  const legsByOs = new Map(legs.map((leg) => [leg.os, leg]))
  const expectedArtifacts = {
    'ubuntu-latest': ['*.deb', '*.rpm', '*-setup-*.exe', 'latest.yml'],
    'macos-latest': ['*.zip', 'latest-mac.yml'],
  }

  for (const [os, patterns] of Object.entries(expectedArtifacts)) {
    const leg = legsByOs.get(os)
    assert.ok(leg, `release.yml is missing a ${os} leg of the make gate`)
    assert.deepEqual(
      String(leg.artifacts).split(/\s+/).filter(Boolean),
      patterns,
      `the ${os} make leg must assert exactly the artifacts only that ` +
        'runner can produce',
    )
  }

  // Per-leg patterns are useless unless the assertion step reads them.
  const verify = make.steps.find(
    (step) => step.name === 'Verify installer artifacts',
  )
  assert.ok(verify, 'the make gate must verify the artifacts it produced')
  assert.equal(verify.env?.EXPECTED_ARTIFACTS, '${{ matrix.leg.artifacts }}')
  assert.ok(
    verify.run.includes('EXPECTED_ARTIFACTS'),
    'the verification step must iterate the leg-specific pattern list',
  )

  // The rpm/fakeroot install and the NSIS cross-build only make sense on the
  // Linux leg; unguarded they would fail the macOS one.
  for (const stepName of [
    'Install Linux maker tooling',
    'Make (windows NSIS, cross-built)',
  ]) {
    const step = make.steps.find(({ name }) => name === stepName)
    assert.ok(step, `the make gate is missing the "${stepName}" step`)
    assert.match(
      step.if ?? '',
      /ubuntu-latest/,
      `"${stepName}" must be restricted to the Linux leg`,
    )
  }
})
