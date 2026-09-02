#!/usr/bin/env node
// Publishes the draft release for the current tag once every expected
// installer kind has actually landed on it (#720).
//
// `prepare-release` creates the release as a draft so the three-platform
// `publish` matrix has one place to append assets to (#671); nothing used to
// take it back out of draft, so publishing was a manual step a maintainer
// could forget — v0.10.5 sat unpublished for over a month while its tag and
// its build were both green (#698).
//
// This asks the same question `check-release-assets.mjs` asks the *next*
// day — does the release actually carry every expected artifact kind — right
// after the matrix and the release notes are in place, which is exactly the
// condition a human would check before publishing by hand. If anything is
// missing (a leg that reported success but somehow left nothing behind, an
// upload that never finished), the release stays a draft rather than going
// live half-built, and this job fails loudly instead of silently.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { evaluateReleaseAssets } from './check-release-assets.mjs'

const execFileAsync = promisify(execFile)

async function gh(args) {
  const { stdout } = await execFileAsync('gh', args, { env: process.env })
  return stdout
}

// Reuses `evaluateReleaseAssets`'s missing-artifact computation rather than
// its `status` field: that field reports `draft` for any draft release
// regardless of completeness, since a draft is exactly what
// `check-release-assets.mjs` normally treats as its own kind of problem.
// Here the release *is* still a draft by design — what decides publishing is
// only whether every expected artifact kind made it on.
export function describeOutcome({ tag, missing }) {
  if (missing.length === 0) {
    return {
      shouldPublish: true,
      message: `${tag} has every expected artifact kind — publishing.`,
    }
  }
  return {
    shouldPublish: false,
    message:
      `::error::${tag} is missing ${missing.join(', ')}, so it is staying ` +
      'a draft rather than going live half-built. Re-run the failed ' +
      `publish leg, then publish by hand: gh release edit ${tag} ` +
      '--draft=false --latest',
  }
}

async function main() {
  const tag = process.env.TAG
  if (!tag) {
    throw new Error('TAG must be set to the tag of the release to publish.')
  }

  const release = JSON.parse(
    await gh(['release', 'view', tag, '--json', 'assets,isDraft']),
  )
  const { missing } = evaluateReleaseAssets({
    tag,
    release: { draft: release.isDraft, assets: release.assets },
  })
  const outcome = describeOutcome({ tag, missing })

  console.log(outcome.message)
  if (!outcome.shouldPublish) {
    process.exitCode = 1
    return
  }

  await gh(['release', 'edit', tag, '--draft=false', '--latest'])
  console.log(`::notice::Published ${tag}.`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}
