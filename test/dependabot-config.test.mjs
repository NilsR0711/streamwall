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

// The typescript ignore entry is the reason a single blocked major used to
// stall the whole group; it must stay untouched by this split (#426).
test('the existing typescript major-version ignore entry is preserved', () => {
  const { ignore } = findNpmUpdate(readDependabotConfig())

  const typescriptIgnore = ignore.find(
    (entry) => entry['dependency-name'] === 'typescript',
  )
  assert.ok(typescriptIgnore, 'the typescript ignore entry must stay in place')
  assert.deepEqual(typescriptIgnore['update-types'], [
    'version-update:semver-major',
  ])
})

// @playwright/test was ignored only until upstream stopped hard-failing on
// unresolved hoisted tsconfig `extends` paths (#691); once upgraded, the
// entry must not linger and keep blocking future Dependabot updates.
test('the @playwright/test ignore entry is gone now that it has been upgraded', () => {
  const { ignore } = findNpmUpdate(readDependabotConfig())

  assert.ok(
    !ignore.some((entry) => entry['dependency-name'] === '@playwright/test'),
    'the @playwright/test ignore entry should have been removed as part of #691',
  )
})
