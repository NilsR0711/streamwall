#!/usr/bin/env node
// Bumps every manifest that tracks the release line in one step. See
// CONTRIBUTING.md for which workspaces track the release line and why.
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))

export const RELEASE_PLEASE_MANIFEST = '.release-please-manifest.json'

export const RELEASE_TRACKED_WORKSPACES = [
  'packages/streamwall',
  'packages/streamwall-control-server',
]

const SEMVER_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export function parseVersionArg(argv) {
  const version = argv[0]
  if (!version) {
    throw new Error(
      'Usage: npm run release:version -- <x.y.z>\n' +
        'Example: npm run release:version -- 0.9.2',
    )
  }
  if (!SEMVER_PATTERN.test(version)) {
    throw new Error(
      `"${version}" is not a valid semantic version (expected e.g. "1.2.3" or "1.2.3-pre1").`,
    )
  }
  return version
}

// The root manifest carries the project version release-please releases from
// (see release-please-config.json); `--no-workspaces` keeps this bump off the
// pinned workspaces.
export function buildRootVersionArgs(version) {
  return ['version', version, '--no-git-tag-version', '--no-workspaces']
}

export function buildNpmVersionArgs(version) {
  return [
    ...RELEASE_TRACKED_WORKSPACES.flatMap((workspace) => ['-w', workspace]),
    'version',
    version,
    '--no-git-tag-version',
  ]
}

// release-please reads the current version from its manifest, not from
// package.json, so a manual bump has to move it too or the next automated
// release PR would propose a version that was already cut.
export function buildReleasePleaseManifest(version) {
  return `${JSON.stringify({ '.': version }, null, 2)}\n`
}

function main() {
  let version
  try {
    version = parseVersionArg(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
  for (const args of [
    buildRootVersionArgs(version),
    buildNpmVersionArgs(version),
  ]) {
    const result = spawnSync('npm', args, { stdio: 'inherit' })
    if (result.status !== 0) {
      process.exit(result.status ?? 1)
    }
  }
  writeFileSync(
    join(rootDir, RELEASE_PLEASE_MANIFEST),
    buildReleasePleaseManifest(version),
  )
  console.log(
    `\nBumped the root manifest, ${RELEASE_PLEASE_MANIFEST} and ` +
      `${RELEASE_TRACKED_WORKSPACES.join(' and ')} to ${version} (package-lock.json included).\n` +
      'streamwall-shared, streamwall-control-ui, streamwall-control-client, and streamwall-control-e2e ' +
      'do not track the release line and were left unchanged.',
  )
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
