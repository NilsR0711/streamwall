#!/usr/bin/env node
// Bumps every manifest that tracks the release line in one step. See
// CONTRIBUTING.md for which workspaces track the release line and why.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

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

export function buildNpmVersionArgs(version) {
  return [
    ...RELEASE_TRACKED_WORKSPACES.flatMap((workspace) => ['-w', workspace]),
    'version',
    version,
    '--no-git-tag-version',
  ]
}

function main() {
  let version
  try {
    version = parseVersionArg(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
  const result = spawnSync('npm', buildNpmVersionArgs(version), {
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
  console.log(
    `\nBumped ${RELEASE_TRACKED_WORKSPACES.join(' and ')} to ${version} (package-lock.json included).\n` +
      'streamwall-shared, streamwall-control-ui, streamwall-control-client, and streamwall-control-e2e ' +
      'do not track the release line and were left unchanged.',
  )
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
