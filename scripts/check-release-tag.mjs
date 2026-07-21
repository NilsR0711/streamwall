#!/usr/bin/env node
// Fails when `main` claims a release version that was never tagged (#515).
//
// release-please runs with `skip-github-release` (#457): it opens the release
// PR with the version bump and the changelog, but pushing the `vX.Y.Z` tag
// stays a manual step, because a tag created with a workflow's GITHUB_TOKEN
// does not trigger other workflows and would therefore never start
// `release.yml`. Nothing used to notice when that last step was forgotten:
// `main` then advertises a version that has no GitHub Release and no
// installers, and the control server's update check — which compares its own
// version against the release tags — keeps telling self-hosters that they are
// up to date.
//
// A tag is pushed by hand moments after the release PR merges, so a freshly
// bumped version without a tag is normal for a while; only a version that has
// been sitting untagged past the grace period is reported.
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))

// The version bump lands on `main` with the release PR merge; a day is long
// enough for the maintainer who merged it to push the tag.
export const GRACE_PERIOD_HOURS = 24

// Mirrors the version format release-please writes into the manifests; the tag
// is that version with a `v` prefix (`include-v-in-tag`).
const SEMVER_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

export function parseTags(stdout) {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

export function evaluateReleaseTag({ version, tags, versionCommittedAt, now }) {
  if (!SEMVER_PATTERN.test(version)) {
    throw new Error(`"${version}" is not a valid semantic version.`)
  }

  const committedAt = new Date(versionCommittedAt)
  if (Number.isNaN(committedAt.getTime())) {
    throw new Error(
      `Could not read the commit date of the release version ` +
        `("${versionCommittedAt}") — is this a shallow clone?`,
    )
  }

  const tag = `v${version}`
  const ageHours = (now.getTime() - committedAt.getTime()) / (60 * 60 * 1000)

  if (tags.includes(tag)) {
    return { status: 'tagged', tag, version, ageHours }
  }
  return {
    status: ageHours < GRACE_PERIOD_HOURS ? 'pending' : 'missing',
    tag,
    version,
    ageHours,
  }
}

export function formatReport({ status, tag, version, ageHours }) {
  const hours = Math.round(ageHours)

  if (status === 'tagged') {
    return `main is on ${version} and ${tag} exists.`
  }
  if (status === 'pending') {
    return (
      `::notice::main is on ${version} but ${tag} does not exist yet ` +
      `(bumped ${hours}h ago, within the ${GRACE_PERIOD_HOURS}h grace ` +
      'period).'
    )
  }
  return (
    `::error::main has claimed ${version} for ${hours}h without a ${tag} ` +
    'tag, so no GitHub Release and no installers were ever built. Push the ' +
    `tag to run release.yml: git checkout main && git pull && git tag ${tag} ` +
    `&& git push origin ${tag}`
  )
}

async function git(args) {
  const { stdout } = await execFileAsync('git', args, { cwd: rootDir })
  return stdout
}

async function main() {
  const { version } = JSON.parse(
    readFileSync(join(rootDir, 'package.json'), 'utf8'),
  )

  // The release-please manifest changes in exactly the commits that move the
  // release line, so its last commit dates the version currently on `main` —
  // unlike package.json, which any dependency bump touches.
  const result = evaluateReleaseTag({
    version,
    tags: parseTags(await git(['tag', '--list', 'v*'])),
    versionCommittedAt: (
      await git([
        'log',
        '-1',
        '--format=%cI',
        '--',
        '.release-please-manifest.json',
      ])
    ).trim(),
    now: new Date(),
  })

  console.log(formatReport(result))
  if (result.status === 'missing') {
    process.exitCode = 1
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  await main()
}
