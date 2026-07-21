import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildNpmVersionArgs,
  buildReleasePleaseManifest,
  buildRootVersionArgs,
  parseVersionArg,
  RELEASE_TRACKED_WORKSPACES,
} from '../scripts/release-version.mjs'

test('parseVersionArg accepts a plain semantic version', () => {
  assert.equal(parseVersionArg(['0.9.2']), '0.9.2')
})

test('parseVersionArg accepts a prerelease version', () => {
  assert.equal(parseVersionArg(['2.0.0-pre4']), '2.0.0-pre4')
})

test('parseVersionArg accepts a version with build metadata', () => {
  assert.equal(parseVersionArg(['1.2.3+build.7']), '1.2.3+build.7')
})

test('parseVersionArg rejects a missing argument', () => {
  assert.throws(() => parseVersionArg([]), /Usage: npm run release:version/)
})

test('parseVersionArg rejects a version with a leading "v"', () => {
  assert.throws(
    () => parseVersionArg(['v0.9.2']),
    /not a valid semantic version/,
  )
})

test('parseVersionArg rejects a non-semver string', () => {
  assert.throws(
    () => parseVersionArg(['latest']),
    /not a valid semantic version/,
  )
})

test('parseVersionArg rejects a partial version', () => {
  assert.throws(() => parseVersionArg(['0.9']), /not a valid semantic version/)
})

test('RELEASE_TRACKED_WORKSPACES lists exactly the manifests pinned by the version-sync test', () => {
  assert.deepEqual(RELEASE_TRACKED_WORKSPACES, [
    'packages/streamwall',
    'packages/streamwall-control-server',
  ])
})

// The root manifest is the version release-please derives the release from
// (release-please-config.json releases the "." package), so the manual path has
// to move it in lockstep with the workspaces.
test('buildRootVersionArgs bumps only the root manifest', () => {
  assert.deepEqual(buildRootVersionArgs('0.9.2'), [
    'version',
    '0.9.2',
    '--no-git-tag-version',
    '--no-workspaces',
  ])
})

test('buildReleasePleaseManifest keeps release-please in step with a manual bump', () => {
  assert.equal(buildReleasePleaseManifest('0.9.2'), '{\n  ".": "0.9.2"\n}\n')
})

test('buildNpmVersionArgs bumps every release-tracked workspace without tagging', () => {
  assert.deepEqual(buildNpmVersionArgs('0.9.2'), [
    '-w',
    'packages/streamwall',
    '-w',
    'packages/streamwall-control-server',
    'version',
    '0.9.2',
    '--no-git-tag-version',
  ])
})
