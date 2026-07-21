import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))

function readRootFile(relativePath) {
  return readFileSync(join(rootDir, relativePath), 'utf8')
}

// The release line is driven by packages/streamwall/package.json (see the
// "Cutting a release" section in CONTRIBUTING.md). Tie the changelog to that
// same manifest so a version bump without a matching CHANGELOG entry fails
// here, giving contributors the feedback loop the commit convention promises.
function readReleaseVersion() {
  const manifest = JSON.parse(readRootFile('packages/streamwall/package.json'))
  return manifest.version
}

test('CHANGELOG.md keeps an Unreleased section', () => {
  const changelog = readRootFile('CHANGELOG.md')
  assert.match(
    changelog,
    /^## \[Unreleased\]/m,
    'CHANGELOG.md must keep an "## [Unreleased]" section for pending changes',
  )
})

test('CHANGELOG.md documents the current release version', () => {
  const changelog = readRootFile('CHANGELOG.md')
  const version = readReleaseVersion()
  const heading = new RegExp(
    `^## \\[${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`,
    'm',
  )
  assert.match(
    changelog,
    heading,
    `CHANGELOG.md must document the current release version ${version} ` +
      `(bumped in packages/streamwall/package.json). Add a "## [${version}]" section.`,
  )
})
