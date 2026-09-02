import { load } from 'js-yaml'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))

function readDependabotConfig() {
  return load(readFileSync(join(rootDir, '.github/dependabot.yml'), 'utf8'))
}

function findNpmUpdate(config) {
  const npmUpdate = config.updates.find(
    (update) => update['package-ecosystem'] === 'npm',
  )
  assert.ok(npmUpdate, 'dependabot.yml is missing the npm update block')
  return npmUpdate
}

// A grouped Dependabot PR is all-or-nothing: one uninstallable member blocks
// every other update in the same group. Splitting by update-type keeps a
// blocked major from holding back the low-risk minor/patch batch (#690).
test('the npm groups are split into minor-patch and major per dependency-type', () => {
  const { groups } = findNpmUpdate(readDependabotConfig())

  const expected = {
    'production-minor-patch': {
      'dependency-type': 'production',
      'update-types': ['minor', 'patch'],
    },
    'production-major': {
      'dependency-type': 'production',
      'update-types': ['major'],
    },
    'development-minor-patch': {
      'dependency-type': 'development',
      'update-types': ['minor', 'patch'],
    },
    'development-major': {
      'dependency-type': 'development',
      'update-types': ['major'],
    },
  }

  assert.deepEqual(
    Object.keys(groups).sort(),
    Object.keys(expected).sort(),
    'dependabot.yml npm groups must be exactly the four minor-patch/major ' +
      'groups, no more and no less',
  )

  for (const [name, config] of Object.entries(expected)) {
    assert.deepEqual(
      groups[name],
      config,
      `dependabot.yml group "${name}" does not match the expected split`,
    )
  }
})

// The old undifferentiated groups must not silently reappear alongside (or
// instead of) the split ones.
test('the old undifferentiated npm groups are gone', () => {
  const { groups } = findNpmUpdate(readDependabotConfig())

  assert.ok(
    !('production-dependencies' in groups),
    'the undifferentiated "production-dependencies" group should be split ' +
      'into production-minor-patch/production-major',
  )
  assert.ok(
    !('development-dependencies' in groups),
    'the undifferentiated "development-dependencies" group should be split ' +
      'into development-minor-patch/development-major',
  )
})

// The typescript/@playwright/test ignore entries are the reason a single
// blocked major used to stall the whole group; they must stay untouched by
// this split (typescript majors: #426, @playwright/test: #691).
test('the existing major-version ignore entries are preserved', () => {
  const { ignore } = findNpmUpdate(readDependabotConfig())

  const typescriptIgnore = ignore.find(
    (entry) => entry['dependency-name'] === 'typescript',
  )
  assert.ok(typescriptIgnore, 'the typescript ignore entry must stay in place')
  assert.deepEqual(typescriptIgnore['update-types'], [
    'version-update:semver-major',
  ])

  const playwrightIgnore = ignore.find(
    (entry) => entry['dependency-name'] === '@playwright/test',
  )
  assert.ok(
    playwrightIgnore,
    'the @playwright/test ignore entry must stay in place',
  )
  assert.deepEqual(playwrightIgnore['update-types'], [
    'version-update:semver-minor',
    'version-update:semver-major',
  ])
})
