#!/usr/bin/env node
// Fails when the `vX.Y.Z` tag of the version on `main` did not produce an
// installable release (#533).
//
// `check-release-tag.mjs` only asserts that the tag for the version on `main`
// exists; it never looks at what the tag produced. A tag can exist while the
// release behind it is unusable:
//
//   - one leg of `release.yml`'s three-platform publish matrix failed, so the
//     GitHub Release is missing that platform's installers (#453),
//   - `release.yml` never ran for the tag at all — pushed from a workflow
//     token, or the run was cancelled — so there is no release behind the tag,
//   - the release was built but never taken out of draft (#698), so nothing
//     outside the maintainer's releases page can see it.
//
// Both point self-hosters and the app's updater at a release that cannot be
// installed, and neither shows up anywhere. The expected artifact kinds are
// the ones the `make` job in `release.yml` already asserts on the runner,
// checked here against what actually reached the release.
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))

// Mirrors the `artifacts` lists of `release.yml`'s `make` matrix: deb/rpm from
// the Linux publish leg, the NSIS installer plus `latest.yml` from the Windows
// leg, the ZIP plus `latest-mac.yml` from the macOS leg. `latest*.yml` is what
// electron-updater reads, so a release without it silently stops updating
// installed apps.
export const EXPECTED_ASSET_PATTERNS = [
  '*.deb',
  '*.rpm',
  '*-setup-*.exe',
  'latest.yml',
  '*.zip',
  'latest-mac.yml',
]

function assetPatternToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  // Anchored, so `*.zip` is not satisfied by `installer.zip.blockmap`.
  return new RegExp(`^${escaped.replace(/\*/g, '.*')}$`)
}

// v0.9.1 and everything before it was published with Squirrel, which names
// its installer `Streamwall-<version>.Setup.exe` and ships `RELEASES` plus a
// `.nupkg` instead of the `latest*.yml` electron-updater reads (#454). Those
// releases can no longer be rebuilt, so judging them by the current artifact
// list would leave the daily run permanently red.
export const FIRST_CHECKED_VERSION = '0.9.2'

function isBefore(version, floor) {
  // Only the release numbers are compared: a prerelease of the floor version
  // is already built by the current pipeline and belongs in the check.
  const parse = (value) => value.split('-')[0].split('.').map(Number)
  const left = parse(version)
  const right = parse(floor)

  for (let index = 0; index < right.length; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] < right[index]
    }
  }
  return false
}

// The release to inspect is the one `main` currently claims, not simply the
// highest tag: a tag can sort above the release line without being the
// release this repository stands on — a prerelease tag, or a tag inherited
// from another project and never pruned from a clone (#554). The manifest is
// the only statement of which version `main` is meant to have shipped.
//
// A version whose tag was never pushed is `check-release-tag.mjs`'s finding,
// so it is skipped here rather than reported a second time.
export function selectReleaseTag({ version, tags }) {
  const tag = `v${version}`

  if (isBefore(version, FIRST_CHECKED_VERSION)) {
    return { status: 'legacy', tag }
  }
  if (!tags.includes(tag)) {
    return { status: 'no-tag', tag: null }
  }
  return { status: 'check', tag }
}

// A transient GitHub API error (a 5xx, a rate limit, or a plain network
// failure) says nothing about whether the release is actually broken. Retried
// a few times it usually clears on its own; if it still has not after that,
// this script exits with this dedicated code so the workflow can treat the
// run as inconclusive instead of reporting "the release is broken" over a
// blip in GitHub's API (#721).
export const TRANSIENT_EXIT_CODE = 2

const DEFAULT_RETRIES = 3
const DEFAULT_BASE_DELAY_MS = 500

function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

// A 5xx or a 429 is GitHub having a bad moment; a 403 carrying `retry-after`
// is its secondary rate limit, which behaves the same way. A plain 403 with
// no such header is a permissions problem instead — retrying that would only
// hide a bad token behind a few seconds of silence.
export function isTransientResponse(response) {
  if (response.status === 429 || response.status >= 500) {
    return true
  }
  if (response.status === 403) {
    return response.headers?.get?.('retry-after') != null
  }
  return false
}

function backoffDelayMs(response, attempt, baseDelayMs) {
  const retryAfter = response?.headers?.get?.('retry-after')
  if (retryAfter != null) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000
    }
  }
  return baseDelayMs * 2 ** (attempt - 1)
}

function markTransient(error) {
  error.transient = true
  return error
}

// Translates a `fetchReleaseByTag` failure into what the CLI should do about
// it: `null` for anything that is a real problem and must keep failing loudly
// (a bad token, an exhausted page limit), or the exit code and message for a
// transient one that could not be resolved even after retrying.
export function classifyFetchError(error) {
  if (!error?.transient) {
    return null
  }
  return {
    exitCode: TRANSIENT_EXIT_CODE,
    message:
      `::warning::${error.message} Retried and still could not reach the ` +
      'GitHub API, so this run cannot tell whether the release is complete ' +
      '— treating it as inconclusive rather than reporting a broken release.',
  }
}

export function parseRepository(remoteUrl) {
  const match = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(
    remoteUrl.trim(),
  )
  if (!match) {
    throw new Error(
      `Could not read a GitHub repository from the remote "${remoteUrl.trim()}".`,
    )
  }
  return match[1]
}

export function evaluateReleaseAssets({ tag, release }) {
  if (release === null) {
    return { status: 'no-release', tag, missing: [...EXPECTED_ASSET_PATTERNS] }
  }

  // GitHub lists an asset as soon as its upload starts; only `uploaded` ones
  // can actually be downloaded.
  const names = (release.assets ?? [])
    .filter((asset) => asset.state === 'uploaded')
    .map((asset) => asset.name)
  const missing = EXPECTED_ASSET_PATTERNS.filter((pattern) => {
    const matcher = assetPatternToRegExp(pattern)
    return !names.some((name) => matcher.test(name))
  })

  if (release.draft) {
    return { status: 'draft', tag, missing }
  }
  return {
    status: missing.length === 0 ? 'complete' : 'incomplete',
    tag,
    missing,
  }
}

export function formatReport({ status, tag, missing }) {
  if (status === 'no-tag') {
    return (
      '::notice::The version on main has no tag yet, so there is no release ' +
      'to check — see the release tag check above.'
    )
  }
  if (status === 'legacy') {
    return (
      `::notice::${tag} predates ${FIRST_CHECKED_VERSION}, the first version ` +
      'built with electron-updater, so its artifact names are not the ones ' +
      'this check knows about.'
    )
  }
  if (status === 'complete') {
    return `${tag} has a published release with every expected artifact kind.`
  }
  if (status === 'no-release') {
    return (
      `::error::${tag} has no GitHub Release, so the tag shipped no ` +
      'installers. Re-run release.yml for the tag (Actions → Release → Run ' +
      'workflow); the tag stays, it is the record of what was released.'
    )
  }
  if (status === 'draft') {
    return (
      `::error::The release for ${tag} is still a draft, so neither the ` +
      'updater nor a self-hoster can see it. Publish it in the releases UI.'
    )
  }
  return (
    `::error::The release for ${tag} is missing ${missing.join(', ')} — a ` +
    'publish leg of release.yml failed, so the release is only partially ' +
    'populated. Re-run the failed leg and check the release assets.'
  )
}

async function git(args) {
  const { stdout } = await execFileAsync('git', args, { cwd: rootDir })
  return stdout
}

// A draft release carries its `tag_name` but is not attached to the tag yet,
// so `GET /releases/tags/<tag>` answers 404 for one no matter how privileged
// the token is (#698). Reading the listing instead is the only way to see a
// draft — and the listing only includes drafts for a token with push access,
// which is why the workflow's job runs with `contents: write`.
export function findReleaseByTag(releases, tag) {
  const matches = releases.filter((release) => release.tag_name === tag)

  if (matches.length === 0) {
    return null
  }
  // One tag has carried two releases here before: with no draft present yet,
  // two publish legs each created their own (#671). The published one is what
  // the updater and a self-hoster see, so it decides the verdict whatever
  // order the listing returns them in.
  return matches.find((release) => !release.draft) ?? matches[0]
}

// Paged rather than asked for by tag, for the reason above. The release this
// check is after is the newest one and the listing is newest-first, so the
// first page all but always answers it; the later pages cover a release
// published out of order. Exhausting them without a match is reported as its
// own error rather than as "no release": blaming a paging limit on a missing
// release would be the same misdiagnosis this check exists to avoid.
//
// The token the workflow passes in also lifts the anonymous rate limit.
//
// Each page request is retried on a transient failure (#721): GitHub having a
// bad moment does not mean the release is broken, so a 5xx, a rate limit, or
// a plain network error gets a few attempts with backoff before this gives
// up and marks the error transient for the caller to report as inconclusive.
export async function fetchReleaseByTag({
  repository,
  tag,
  token,
  fetchImpl = fetch,
  perPage = 100,
  maxPages = 5,
  retries = DEFAULT_RETRIES,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  sleep = defaultSleep,
}) {
  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await fetchReleasesPage({
      repository,
      page,
      perPage,
      token,
      fetchImpl,
      retries,
      baseDelayMs,
      sleep,
    })
    const release = findReleaseByTag(batch, tag)

    if (release !== null) {
      return release
    }
    if (batch.length < perPage) {
      return null
    }
  }
  throw new Error(
    `${tag} is not among the ${maxPages * perPage} most recent releases of ` +
      `${repository}, so this check cannot tell what it produced.`,
  )
}

async function fetchReleasesPage({
  repository,
  page,
  perPage,
  token,
  fetchImpl,
  retries,
  baseDelayMs,
  sleep,
}) {
  const url =
    `https://api.github.com/repos/${repository}/releases` +
    `?per_page=${perPage}&page=${page}`
  const init = {
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  }

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    let response
    try {
      response = await fetchImpl(url, init)
    } catch (networkError) {
      if (attempt === retries) {
        throw markTransient(
          new Error(
            `Could not reach the GitHub API for the releases of ` +
              `${repository}: ${networkError.message}`,
          ),
        )
      }
      await sleep(baseDelayMs * 2 ** (attempt - 1))
      continue
    }

    if (response.ok) {
      return response.json()
    }

    const message = `GitHub API returned ${response.status} for the releases of ${repository}.`
    if (!isTransientResponse(response)) {
      throw new Error(message)
    }
    if (attempt === retries) {
      throw markTransient(new Error(message))
    }
    await sleep(backoffDelayMs(response, attempt, baseDelayMs))
  }
  // Unreachable: `retries` is always at least 1, so the loop above either
  // returns or throws before falling out the bottom.
  throw new Error(`Could not fetch the releases of ${repository}.`)
}

async function main() {
  const { version } = JSON.parse(
    readFileSync(join(rootDir, 'package.json'), 'utf8'),
  )
  const selected = selectReleaseTag({
    version,
    tags: (await git(['tag', '--list', 'v*']))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== ''),
  })

  if (selected.status !== 'check') {
    console.log(formatReport({ ...selected, missing: [] }))
    return
  }
  const { tag } = selected

  const repository =
    process.env.GITHUB_REPOSITORY ||
    parseRepository(await git(['remote', 'get-url', 'origin']))

  let release
  try {
    release = await fetchReleaseByTag({
      repository,
      tag,
      token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
    })
  } catch (error) {
    const classified = classifyFetchError(error)
    if (!classified) {
      throw error
    }
    console.log(classified.message)
    process.exitCode = classified.exitCode
    return
  }

  const result = evaluateReleaseAssets({ tag, release })

  console.log(formatReport(result))
  if (result.status !== 'complete') {
    process.exitCode = 1
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  await main()
}
