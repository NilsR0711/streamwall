import { load } from 'js-yaml'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  EXPECTED_ASSET_PATTERNS,
  FIRST_CHECKED_VERSION,
  TRANSIENT_EXIT_CODE,
  classifyFetchError,
  evaluateReleaseAssets,
  fetchReleaseByTag,
  findReleaseByTag,
  formatReport,
  isTransientResponse,
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

// A tag that sorts above the release line is not automatically the release
// this repository stands on: a prerelease tag, or a tag inherited from another
// project and left behind in a clone (#554), has no release here. Anchoring on
// the version `main` claims skips them.
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

// A draft release has no tag association on GitHub yet, so
// `GET /releases/tags/<tag>` answers 404 for it however privileged the token
// is (#698). Only the listing carries drafts, and matching on `tag_name` is
// what tells a draft release apart from a tag that produced nothing at all.
test('findReleaseByTag finds a draft release the tag endpoint cannot return', () => {
  const draft = { tag_name: 'v0.9.1', draft: true, assets: [] }

  assert.equal(
    findReleaseByTag([{ tag_name: 'v0.9.0', draft: false }, draft], 'v0.9.1'),
    draft,
  )
})

test('findReleaseByTag reports no release when the listing holds none for the tag', () => {
  assert.equal(
    findReleaseByTag([{ tag_name: 'v0.9.0', draft: false }], 'v0.9.1'),
    null,
  )
})

// Two publish legs racing on a tag with no draft yet each created their own
// release (#671). The published one is the one anybody can install.
test('findReleaseByTag prefers the published release when a tag carries two', () => {
  const published = { tag_name: 'v0.9.1', draft: false, assets: [] }

  assert.equal(
    findReleaseByTag(
      [{ tag_name: 'v0.9.1', draft: true, assets: [] }, published],
      'v0.9.1',
    ),
    published,
  )
})

function listingResponse(releases) {
  return { ok: true, status: 200, json: async () => releases }
}

// The endpoint is the fix: `GET /releases/tags/<tag>` cannot see a draft, the
// listing can.
test('fetchReleaseByTag reads the listing rather than the tag endpoint', async () => {
  const draft = { tag_name: 'v0.9.1', draft: true, assets: [] }
  const urls = []

  const release = await fetchReleaseByTag({
    repository: 'streamwallhq/streamwall',
    tag: 'v0.9.1',
    token: 'secret',
    fetchImpl: async (url, init) => {
      urls.push(url)
      assert.equal(init.headers.authorization, 'Bearer secret')
      return listingResponse([draft])
    },
  })

  assert.equal(release, draft)
  assert.deepEqual(urls, [
    'https://api.github.com/repos/streamwallhq/streamwall/releases?per_page=100&page=1',
  ])
})

test('fetchReleaseByTag stops at the page holding the release', async () => {
  let pages = 0

  const release = await fetchReleaseByTag({
    repository: 'streamwallhq/streamwall',
    tag: 'v0.9.1',
    perPage: 2,
    fetchImpl: async () => {
      pages += 1
      return listingResponse(
        pages === 1
          ? [{ tag_name: 'v1.0.0' }, { tag_name: 'v0.9.2' }]
          : [{ tag_name: 'v0.9.1' }, { tag_name: 'v0.9.0' }],
      )
    },
  })

  assert.equal(release.tag_name, 'v0.9.1')
  assert.equal(pages, 2)
})

test('fetchReleaseByTag reports no release once the listing is exhausted', async () => {
  const release = await fetchReleaseByTag({
    repository: 'streamwallhq/streamwall',
    tag: 'v0.9.1',
    perPage: 2,
    fetchImpl: async () => listingResponse([{ tag_name: 'v1.0.0' }]),
  })

  assert.equal(release, null)
})

// Blaming a paging limit on a release that was never built would be the same
// misdiagnosis this check exists to avoid.
test('fetchReleaseByTag fails loudly when it runs out of pages', async () => {
  await assert.rejects(
    fetchReleaseByTag({
      repository: 'streamwallhq/streamwall',
      tag: 'v0.9.1',
      perPage: 1,
      maxPages: 2,
      fetchImpl: async () => listingResponse([{ tag_name: 'v1.0.0' }]),
    }),
    /most recent releases/,
  )
})

test('fetchReleaseByTag fails on an API error rather than reading it as absent', async () => {
  await assert.rejects(
    fetchReleaseByTag({
      repository: 'streamwallhq/streamwall',
      tag: 'v0.9.1',
      // A single attempt: this test is about the error message, not retries,
      // which are covered separately below.
      retries: 1,
      fetchImpl: async () => ({ ok: false, status: 503, headers: noHeaders }),
    }),
    /503/,
  )
})

// A 5xx, a 429, or a 403 carrying `retry-after` says nothing about whether
// the release is broken — only that the API had a bad moment. A plain 403
// (no `retry-after`) is a permissions problem and must not be treated the
// same way, or a bad token would retry forever instead of failing loudly.
test('isTransientResponse recognizes retryable GitHub API responses', () => {
  assert.equal(isTransientResponse({ status: 500, headers: noHeaders }), true)
  assert.equal(isTransientResponse({ status: 502, headers: noHeaders }), true)
  assert.equal(isTransientResponse({ status: 429, headers: noHeaders }), true)
  assert.equal(
    isTransientResponse({ status: 403, headers: retryAfterHeaders('30') }),
    true,
  )
  assert.equal(isTransientResponse({ status: 403, headers: noHeaders }), false)
  assert.equal(isTransientResponse({ status: 404, headers: noHeaders }), false)
})

function noSleep() {
  return Promise.resolve()
}

const noHeaders = { get: () => null }

function retryAfterHeaders(value) {
  return { get: (name) => (name === 'retry-after' ? value : null) }
}

test('fetchReleaseByTag retries a transient response and succeeds once it recovers', async () => {
  const draft = { tag_name: 'v0.9.1', draft: false, assets: [] }
  let calls = 0
  const delays = []

  const release = await fetchReleaseByTag({
    repository: 'streamwallhq/streamwall',
    tag: 'v0.9.1',
    retries: 3,
    sleep: async (ms) => {
      delays.push(ms)
    },
    fetchImpl: async () => {
      calls += 1
      if (calls < 3) {
        return { ok: false, status: 503, headers: noHeaders }
      }
      return listingResponse([draft])
    },
  })

  assert.equal(release, draft)
  assert.equal(calls, 3)
  assert.equal(delays.length, 2)
})

test('fetchReleaseByTag honours a Retry-After header when backing off', async () => {
  let calls = 0
  const delays = []

  await fetchReleaseByTag({
    repository: 'streamwallhq/streamwall',
    tag: 'v0.9.1',
    retries: 2,
    sleep: async (ms) => {
      delays.push(ms)
    },
    fetchImpl: async () => {
      calls += 1
      if (calls === 1) {
        return { ok: false, status: 429, headers: retryAfterHeaders('7') }
      }
      return listingResponse([])
    },
  })

  assert.deepEqual(delays, [7000])
})

// A network failure (DNS, connection reset, timeout) throws out of `fetch`
// itself rather than returning a response, and is just as much a blip as a
// 503 — it must be retried the same way.
test('fetchReleaseByTag retries a network error thrown by fetch', async () => {
  let calls = 0

  const release = await fetchReleaseByTag({
    repository: 'streamwallhq/streamwall',
    tag: 'v0.9.1',
    retries: 2,
    sleep: noSleep,
    fetchImpl: async () => {
      calls += 1
      if (calls === 1) {
        throw new Error('getaddrinfo ENOTFOUND api.github.com')
      }
      return listingResponse([])
    },
  })

  assert.equal(release, null)
  assert.equal(calls, 2)
})

test('fetchReleaseByTag marks the error transient once retries are exhausted', async () => {
  await assert.rejects(
    fetchReleaseByTag({
      repository: 'streamwallhq/streamwall',
      tag: 'v0.9.1',
      retries: 3,
      sleep: noSleep,
      fetchImpl: async () => ({ ok: false, status: 503, headers: noHeaders }),
    }),
    (error) => {
      assert.match(error.message, /503/)
      assert.equal(error.transient, true)
      return true
    },
  )
})

// A non-transient failure (a bad token, a repository that does not exist) is
// a real problem, not a blip — retrying it would only delay the report.
test('fetchReleaseByTag does not retry a non-transient API error', async () => {
  let calls = 0

  await assert.rejects(
    fetchReleaseByTag({
      repository: 'streamwallhq/streamwall',
      tag: 'v0.9.1',
      retries: 3,
      sleep: noSleep,
      fetchImpl: async () => {
        calls += 1
        return { ok: false, status: 404, headers: noHeaders }
      },
    }),
    (error) => {
      assert.match(error.message, /404/)
      assert.ok(!error.transient)
      return true
    },
  )
  assert.equal(calls, 1)
})

test('classifyFetchError describes a transient failure as inconclusive rather than broken', () => {
  const error = new Error('GitHub API returned 503 for the releases of x/y.')
  error.transient = true

  const classified = classifyFetchError(error)

  assert.equal(classified.exitCode, TRANSIENT_EXIT_CODE)
  assert.match(classified.message, /^::warning::/)
  assert.match(classified.message, /503/)
})

test('classifyFetchError leaves a non-transient error for the caller to rethrow', () => {
  assert.equal(classifyFetchError(new Error('boom')), null)
})

// "Delete and re-push the tag" throws away the only record of what shipped
// and, for a release that is merely unpublished, fixes nothing.
test('formatReport does not advise deleting the tag of a missing release', () => {
  const report = formatReport({
    status: 'no-release',
    tag: 'v0.9.1',
    missing: EXPECTED_ASSET_PATTERNS,
  })

  assert.doesNotMatch(report, /delete/i)
  assert.match(report, /release\.yml/)
})

// Drafts are listed only for a token with push access; with contents: read the
// check read the v0.10.5 draft as a release that never existed and demanded
// the tag be re-pushed (#698). The elevated permission is confined to this
// job, which is why the asset check is not a step of the tag check.
test('the asset check runs with the push access that reveals draft releases', () => {
  const workflow = load(
    readFileSync(join(rootDir, '.github/workflows/release-tag.yml'), 'utf8'),
  )

  assert.equal(
    workflow.jobs.assets.permissions?.contents,
    'write',
    'the asset check needs push access to see draft releases',
  )
  assert.equal(
    workflow.jobs.check.permissions?.contents,
    'read',
    'the tag check must stay read-only',
  )
})

test('the release tag workflow also checks the release assets', () => {
  const workflow = load(
    readFileSync(join(rootDir, '.github/workflows/release-tag.yml'), 'utf8'),
  )
  const job = workflow.jobs.assets
  const step = job.steps.find((candidate) =>
    candidate.run?.includes('scripts/check-release-assets.mjs'),
  )

  assert.ok(step, 'release-tag.yml must run the release asset check')
  // A missing tag must not hide a broken release: the two checks report
  // different halves of the same pipeline, so neither may gate the other.
  assert.equal(job.needs, undefined)
  assert.ok(
    step.env?.GH_TOKEN,
    'the GitHub API call needs a token to stay within the API rate limit',
  )
  // `git tag --list` decides which release is inspected, so this job needs the
  // tags as much as the tag check does.
  const checkout = job.steps.find((candidate) =>
    candidate.uses?.startsWith('actions/checkout@'),
  )
  assert.equal(checkout.with['fetch-depth'], 0)
  // Both failures have to reach the issue the scheduled report files.
  assert.deepEqual(workflow.jobs.report.needs, ['check', 'assets'])
})

// A transient GitHub API error (#721) exits `scripts/check-release-assets.mjs`
// with a dedicated code rather than the generic failure code. The step must
// translate that into a job outcome the report step can tell apart from a
// real failure, or a network blip would still open "the release is broken".
test('the asset check step turns a transient exit code into an inconclusive outcome', () => {
  const workflow = load(
    readFileSync(join(rootDir, '.github/workflows/release-tag.yml'), 'utf8'),
  )
  const job = workflow.jobs.assets
  const step = job.steps.find((candidate) =>
    candidate.run?.includes('scripts/check-release-assets.mjs'),
  )

  assert.equal(step.id, 'assets')
  assert.match(step.run, /\$GITHUB_OUTPUT/)
  assert.match(
    step.run,
    /\b2\b/,
    'the step must check for the transient exit code',
  )

  const report = workflow.jobs.report
  // The base condition still has to cover every job's real result, or a new
  // job could fail silently; the inconclusive outcome only narrows the
  // "success" branch so a transient run neither files nor closes a report.
  assert.match(String(report.with.result), /needs\.\*\.result/)
  assert.match(
    String(report.with.result),
    /needs\.assets\.outputs\.outcome/,
    'a transient run must not be reported as success',
  )
})
