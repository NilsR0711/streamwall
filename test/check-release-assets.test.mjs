import { load } from 'js-yaml'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  EXPECTED_ASSET_PATTERNS,
  FIRST_CHECKED_VERSION,
  evaluateReleaseAssets,
  formatReport,
  parseRepository,
  selectReleaseTag,
} from '../scripts/check-release-assets.mjs'

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))

function uploaded(...names) {
  return names.map((name) => ({ name, state: 'uploaded' }))
}

// The full set a healthy release carries — one artifact per expected kind.
function completeAssets() {
  return uploaded(
    'streamwall_0.9.1_amd64.deb',
    'streamwall-0.9.1-1.x86_64.rpm',
    'streamwall-0.9.1-setup-x64.exe',
    'latest.yml',
    'streamwall-darwin-arm64-0.9.1.zip',
    'latest-mac.yml',
  )
}

test('selectReleaseTag picks the tag of the version main is on', () => {
  assert.deepEqual(
    selectReleaseTag({ version: '1.0.0', tags: ['v0.9.1', 'v1.0.0'] }),
    { status: 'check', tag: 'v1.0.0' },
  )
})

// The repository carries tags inherited from the project it started as
// (`v2.0.0-pre3`), which sort above the current release line but never had a
// GitHub Release here. Anchoring on the version `main` claims skips them.
test('selectReleaseTag ignores tags outside the current release line', () => {
  assert.deepEqual(
    selectReleaseTag({ version: '1.0.0', tags: ['v1.0.0', 'v2.0.0-pre3'] }),
    { status: 'check', tag: 'v1.0.0' },
  )
})

// A version whose tag was never pushed is what check-release-tag.mjs reports;
// repeating it here would raise the same problem twice.
test('selectReleaseTag skips a version that has no tag', () => {
  assert.deepEqual(selectReleaseTag({ version: '1.0.0', tags: ['v0.9.1'] }), {
    status: 'no-tag',
    tag: null,
  })
})

// Releases built before the electron-updater switch (#454) carry Squirrel's
// artifact names and no `latest*.yml` at all; judging them by the current
// artifact list would keep the daily run red over a release nobody can fix.
test('selectReleaseTag skips releases predating the expected artifact set', () => {
  assert.deepEqual(selectReleaseTag({ version: '0.9.1', tags: ['v0.9.1'] }), {
    status: 'legacy',
    tag: 'v0.9.1',
  })
})

test('selectReleaseTag checks a prerelease of the first checked version', () => {
  const { status } = selectReleaseTag({
    version: `${FIRST_CHECKED_VERSION}-rc.1`,
    tags: [`v${FIRST_CHECKED_VERSION}-rc.1`],
  })

  assert.equal(status, 'check')
})

test('parseRepository reads the slug from an HTTPS remote', () => {
  assert.equal(
    parseRepository('https://github.com/streamwallhq/streamwall.git\n'),
    'streamwallhq/streamwall',
  )
})

test('parseRepository reads the slug from an SSH remote', () => {
  assert.equal(
    parseRepository('git@github.com:streamwallhq/streamwall.git'),
    'streamwallhq/streamwall',
  )
})

test('parseRepository rejects a remote that is not on GitHub', () => {
  assert.throws(
    () => parseRepository('https://gitlab.com/streamwallhq/streamwall.git'),
    /GitHub/,
  )
})

test('evaluateReleaseAssets accepts a release carrying every artifact kind', () => {
  const result = evaluateReleaseAssets({
    tag: 'v0.9.1',
    release: { draft: false, assets: completeAssets() },
  })

  assert.equal(result.status, 'complete')
  assert.deepEqual(result.missing, [])
})

// `release.yml` never ran for the tag: pushed from a workflow token, or the
// run was cancelled.
test('evaluateReleaseAssets reports a tag without a release', () => {
  const result = evaluateReleaseAssets({ tag: 'v0.9.1', release: null })

  assert.equal(result.status, 'no-release')
  assert.deepEqual(result.missing, EXPECTED_ASSET_PATTERNS)
})

// A draft is invisible to the updater and to `docker compose pull` alike.
test('evaluateReleaseAssets reports a release that stayed a draft', () => {
  const result = evaluateReleaseAssets({
    tag: 'v0.9.1',
    release: { draft: true, assets: completeAssets() },
  })

  assert.equal(result.status, 'draft')
})

// The partially populated release of #453: one leg of the publish matrix
// failed, so a platform's installers never made it into the release.
test('evaluateReleaseAssets lists the artifact kinds a failed publish leg left out', () => {
  const result = evaluateReleaseAssets({
    tag: 'v0.9.1',
    release: {
      draft: false,
      assets: uploaded(
        'streamwall_0.9.1_amd64.deb',
        'streamwall-0.9.1-1.x86_64.rpm',
        'streamwall-darwin-arm64-0.9.1.zip',
        'latest-mac.yml',
      ),
    },
  })

  assert.equal(result.status, 'incomplete')
  assert.deepEqual(result.missing, ['*-setup-*.exe', 'latest.yml'])
})

// An asset whose upload never finished is listed by the API but cannot be
// downloaded, so it must not count as present.
test('evaluateReleaseAssets ignores assets that are not fully uploaded', () => {
  const assets = completeAssets()
  assets.find((asset) => asset.name === 'latest.yml').state = 'starting'

  const result = evaluateReleaseAssets({
    tag: 'v0.9.1',
    release: { draft: false, assets },
  })

  assert.equal(result.status, 'incomplete')
  assert.deepEqual(result.missing, ['latest.yml'])
})

// `*.zip` must not be satisfied by a Windows installer or a source archive.
test('evaluateReleaseAssets anchors the artifact patterns to the whole name', () => {
  const result = evaluateReleaseAssets({
    tag: 'v0.9.1',
    release: {
      draft: false,
      assets: uploaded(
        'streamwall_0.9.1_amd64.deb.sha256',
        'notes-setup-x64.exe.blockmap',
      ),
    },
  })

  assert.deepEqual(result.missing, EXPECTED_ASSET_PATTERNS)
})

test('formatReport annotates a missing release as an error naming the tag', () => {
  const report = formatReport({
    status: 'no-release',
    tag: 'v0.9.1',
    missing: EXPECTED_ASSET_PATTERNS,
  })

  assert.match(report, /^::error::/m)
  assert.match(report, /v0\.9\.1/)
})

test('formatReport lists every missing artifact kind of an incomplete release', () => {
  const report = formatReport({
    status: 'incomplete',
    tag: 'v0.9.1',
    missing: ['*-setup-*.exe', 'latest.yml'],
  })

  assert.match(report, /^::error::/m)
  assert.match(report, /\*-setup-\*\.exe/)
  assert.match(report, /latest\.yml/)
})

test('formatReport annotates a draft release as an error', () => {
  const report = formatReport({ status: 'draft', tag: 'v0.9.1', missing: [] })

  assert.match(report, /^::error::/m)
  assert.match(report, /draft/)
})

test('formatReport stays quiet for a complete release', () => {
  const report = formatReport({
    status: 'complete',
    tag: 'v0.9.1',
    missing: [],
  })

  assert.doesNotMatch(report, /::error::/)
  assert.match(report, /v0\.9\.1/)
})

// check-release-tag.mjs owns the untagged case; reporting it here as well
// would raise the same problem twice in the same run.
test('formatReport notes an untagged version without failing the run', () => {
  const report = formatReport({ status: 'no-tag', tag: null, missing: [] })

  assert.doesNotMatch(report, /::error::/)
  assert.match(report, /^::notice::/m)
})

test('formatReport notes a release predating the check without failing', () => {
  const report = formatReport({ status: 'legacy', tag: 'v0.9.1', missing: [] })

  assert.doesNotMatch(report, /::error::/)
  assert.match(report, /^::notice::/m)
  assert.match(report, /v0\.9\.1/)
})

test('the release tag workflow also checks the release assets', () => {
  const workflow = load(
    readFileSync(join(rootDir, '.github/workflows/release-tag.yml'), 'utf8'),
  )
  const job = workflow.jobs.check
  const step = job.steps.find((candidate) =>
    candidate.run?.includes('scripts/check-release-assets.mjs'),
  )

  assert.ok(step, 'release-tag.yml must run the release asset check')
  // The asset check must still report when the tag check above it failed.
  assert.match(step.if ?? '', /cancelled/)
  assert.ok(
    step.env?.GH_TOKEN,
    'the GitHub API call needs a token to stay within the API rate limit',
  )
})
