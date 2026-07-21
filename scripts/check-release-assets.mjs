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
//     token, or the run was cancelled — so there is no release behind the tag.
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
// highest tag: the repository still carries `v2.0.0-pre*` tags from the
// project it started as, which sort above the current release line but never
// had a GitHub Release here.
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
      `workflow) or delete and re-push ${tag}.`
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

// The releases endpoint answers 404 both for an unknown tag and for a draft
// release that the token may not read — hence the token, which the workflow
// passes in and which also lifts the anonymous rate limit.
async function fetchReleaseByTag({ repository, tag, token }) {
  const response = await fetch(
    `https://api.github.com/repos/${repository}/releases/tags/${tag}`,
    {
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    },
  )

  if (response.status === 404) {
    return null
  }
  if (!response.ok) {
    throw new Error(
      `GitHub API returned ${response.status} for the release of ${tag}.`,
    )
  }
  return response.json()
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

  const result = evaluateReleaseAssets({
    tag,
    release: await fetchReleaseByTag({
      repository,
      tag,
      token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
    }),
  })

  console.log(formatReport(result))
  if (result.status !== 'complete') {
    process.exitCode = 1
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  await main()
}
