import { load } from 'js-yaml'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  evaluateReleaseTag,
  formatReport,
  GRACE_PERIOD_HOURS,
  parseTags,
} from '../scripts/check-release-tag.mjs'

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))

const NOW = new Date('2026-07-21T12:00:00Z')

function hoursAgo(hours) {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString()
}

test('parseTags splits the tag listing and drops blank lines', () => {
  assert.deepEqual(parseTags('v0.9.0\nv0.9.1\n\n'), ['v0.9.0', 'v0.9.1'])
})

test('parseTags returns an empty list for a repository without tags', () => {
  assert.deepEqual(parseTags('\n'), [])
})

test('evaluateReleaseTag accepts a version that has its tag', () => {
  const result = evaluateReleaseTag({
    version: '0.9.1',
    tags: ['v0.9.0', 'v0.9.1'],
    versionCommittedAt: hoursAgo(72),
    now: NOW,
  })

  assert.equal(result.status, 'tagged')
  assert.equal(result.tag, 'v0.9.1')
})

// The tag is pushed by hand right after the release PR merges, so a run that
// lands in between must not cry wolf.
test('evaluateReleaseTag tolerates a missing tag inside the grace period', () => {
  const result = evaluateReleaseTag({
    version: '0.9.2',
    tags: ['v0.9.1'],
    versionCommittedAt: hoursAgo(GRACE_PERIOD_HOURS - 1),
    now: NOW,
  })

  assert.equal(result.status, 'pending')
  assert.equal(result.tag, 'v0.9.2')
})

test('evaluateReleaseTag reports a tag that stayed missing past the grace period', () => {
  const result = evaluateReleaseTag({
    version: '0.9.2',
    tags: ['v0.9.1'],
    versionCommittedAt: hoursAgo(GRACE_PERIOD_HOURS + 1),
    now: NOW,
  })

  assert.equal(result.status, 'missing')
  assert.equal(result.tag, 'v0.9.2')
  assert.equal(Math.round(result.ageHours), GRACE_PERIOD_HOURS + 1)
})

test('evaluateReleaseTag rejects a version that is not a semantic version', () => {
  assert.throws(
    () =>
      evaluateReleaseTag({
        version: 'v0.9.2',
        tags: [],
        versionCommittedAt: hoursAgo(1),
        now: NOW,
      }),
    /not a valid semantic version/,
  )
})

// A shallow clone reports neither tags nor commit dates; failing loudly beats
// reporting a missing tag that is only missing from the local checkout.
test('evaluateReleaseTag rejects an unusable commit timestamp', () => {
  assert.throws(
    () =>
      evaluateReleaseTag({
        version: '0.9.2',
        tags: [],
        versionCommittedAt: '',
        now: NOW,
      }),
    /commit date/,
  )
})

test('formatReport annotates a missing tag as an error with the push command', () => {
  const report = formatReport({
    status: 'missing',
    tag: 'v0.9.2',
    version: '0.9.2',
    ageHours: 30,
  })

  assert.match(report, /^::error::/m)
  assert.match(report, /git tag v0\.9\.2/)
})

test('formatReport stays quiet for a tagged version', () => {
  const report = formatReport({
    status: 'tagged',
    tag: 'v0.9.1',
    version: '0.9.1',
    ageHours: 72,
  })

  assert.doesNotMatch(report, /::error::/)
  assert.match(report, /v0\.9\.1/)
})

test('formatReport notes a pending tag without failing the run', () => {
  const report = formatReport({
    status: 'pending',
    tag: 'v0.9.2',
    version: '0.9.2',
    ageHours: 2,
  })

  assert.doesNotMatch(report, /::error::/)
  assert.match(report, /^::notice::/m)
})

test('the release tag check runs on a schedule and can be dispatched manually', () => {
  const workflow = load(
    readFileSync(join(rootDir, '.github/workflows/release-tag.yml'), 'utf8'),
  )
  const triggers = Object.keys(workflow.on)

  assert.ok(triggers.includes('schedule'), 'must run on a schedule')
  assert.ok(
    triggers.includes('workflow_dispatch'),
    'must be dispatchable so a maintainer can verify a fresh tag on demand',
  )
  assert.ok(
    !triggers.includes('pull_request'),
    'must not run on pull requests: an untagged release would then block ' +
      'every unrelated change',
  )
})

// `git tag --list` only sees what the checkout fetched, so a shallow clone
// would report every release as untagged.
test('the release tag check checks out the full history including tags', () => {
  const workflow = load(
    readFileSync(join(rootDir, '.github/workflows/release-tag.yml'), 'utf8'),
  )
  const job = workflow.jobs.check
  const checkout = job.steps.find((step) =>
    step.uses?.startsWith('actions/checkout@'),
  )

  assert.ok(checkout, 'release-tag.yml must check the repository out')
  assert.match(
    checkout.uses,
    /@[0-9a-f]{40}$/,
    'actions must be pinned to a commit SHA',
  )
  assert.equal(checkout.with['fetch-depth'], 0)
  assert.equal(job.permissions.contents, 'read')
  assert.match(
    job.steps.map((step) => step.run ?? '').join('\n'),
    /scripts\/check-release-tag\.mjs/,
  )
})
