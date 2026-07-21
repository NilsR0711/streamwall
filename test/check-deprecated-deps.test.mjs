import { load } from 'js-yaml'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  ALLOWLIST_PATH,
  collectDirectDependencies,
  evaluateDeprecations,
  fetchDeprecations,
  formatReport,
  parseAllowlist,
} from '../scripts/check-deprecated-deps.mjs'

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(rootDir, relativePath), 'utf8'))
}

test('collectDirectDependencies resolves declared ranges to locked versions', () => {
  const dependencies = collectDirectDependencies({
    manifests: [
      { path: '', manifest: { devDependencies: { prettier: '^3.9.5' } } },
      { path: 'packages/app', manifest: { dependencies: { luxon: '^3.7.2' } } },
    ],
    lockfile: {
      packages: {
        'node_modules/prettier': { version: '3.9.5' },
        'node_modules/luxon': { version: '3.7.2' },
      },
    },
  })

  assert.deepEqual(dependencies, [
    { name: 'luxon', version: '3.7.2', dependents: ['packages/app'] },
    { name: 'prettier', version: '3.9.5', dependents: ['.'] },
  ])
})

test('collectDirectDependencies covers optional dependencies too', () => {
  const dependencies = collectDirectDependencies({
    manifests: [
      { path: '', manifest: { optionalDependencies: { fsevents: '^2.3.3' } } },
    ],
    lockfile: { packages: { 'node_modules/fsevents': { version: '2.3.3' } } },
  })

  assert.deepEqual(dependencies, [
    { name: 'fsevents', version: '2.3.3', dependents: ['.'] },
  ])
})

test('collectDirectDependencies merges the dependents of a shared version', () => {
  const dependencies = collectDirectDependencies({
    manifests: [
      { path: 'packages/a', manifest: { dependencies: { luxon: '^3.7.2' } } },
      { path: 'packages/b', manifest: { dependencies: { luxon: '^3.0.0' } } },
    ],
    lockfile: { packages: { 'node_modules/luxon': { version: '3.7.2' } } },
  })

  assert.deepEqual(dependencies, [
    {
      name: 'luxon',
      version: '3.7.2',
      dependents: ['packages/a', 'packages/b'],
    },
  ])
})

// A workspace that pins its own copy installs it under its own node_modules,
// and that copy — not the hoisted one — is what the deprecation notice applies
// to, so both versions have to be queried.
test('collectDirectDependencies prefers a nested install over the hoisted one', () => {
  const dependencies = collectDirectDependencies({
    manifests: [
      { path: '', manifest: { devDependencies: { nanoid: '^5.1.6' } } },
      { path: 'packages/a', manifest: { dependencies: { nanoid: '^3.3.11' } } },
    ],
    lockfile: {
      packages: {
        'node_modules/nanoid': { version: '5.1.6' },
        'packages/a/node_modules/nanoid': { version: '3.3.11' },
      },
    },
  })

  assert.deepEqual(dependencies, [
    { name: 'nanoid', version: '3.3.11', dependents: ['packages/a'] },
    { name: 'nanoid', version: '5.1.6', dependents: ['.'] },
  ])
})

test('collectDirectDependencies skips workspace-internal links', () => {
  const dependencies = collectDirectDependencies({
    manifests: [
      {
        path: 'packages/app',
        manifest: { dependencies: { 'streamwall-shared': '^0.0.0' } },
      },
    ],
    lockfile: {
      packages: {
        'node_modules/streamwall-shared': {
          resolved: 'packages/streamwall-shared',
          link: true,
        },
      },
    },
  })

  assert.deepEqual(dependencies, [])
})

test('collectDirectDependencies rejects a dependency missing from the lockfile', () => {
  assert.throws(
    () =>
      collectDirectDependencies({
        manifests: [
          { path: '', manifest: { dependencies: { ghost: '^1.0.0' } } },
        ],
        lockfile: { packages: {} },
      }),
    /ghost.*package-lock\.json/s,
  )
})

test('parseAllowlist indexes tolerated deprecations by package name', () => {
  const allowlist = parseAllowlist({
    allow: [
      {
        package: 'dank-twitch-irc',
        reason: 'Migration in progress',
        issue: 'https://github.com/NilsR0711/streamwall/issues/406',
      },
    ],
  })

  assert.deepEqual([...allowlist.keys()], ['dank-twitch-irc'])
  assert.equal(allowlist.get('dank-twitch-irc').reason, 'Migration in progress')
})

test('parseAllowlist accepts an empty allowlist', () => {
  assert.equal(parseAllowlist({ allow: [] }).size, 0)
})

test('parseAllowlist rejects a missing "allow" array', () => {
  assert.throws(() => parseAllowlist({}), /"allow" array/)
})

test('parseAllowlist rejects an entry without a tracking issue', () => {
  assert.throws(
    () => parseAllowlist({ allow: [{ package: 'foo', reason: 'later' }] }),
    /"issue"/,
  )
})

test('parseAllowlist rejects an entry without a reason', () => {
  assert.throws(
    () => parseAllowlist({ allow: [{ package: 'foo', issue: 'https://x/1' }] }),
    /"reason"/,
  )
})

test('parseAllowlist rejects duplicate packages', () => {
  assert.throws(
    () =>
      parseAllowlist({
        allow: [
          { package: 'foo', reason: 'a', issue: 'https://x/1' },
          { package: 'foo', reason: 'b', issue: 'https://x/2' },
        ],
      }),
    /listed twice/,
  )
})

const luxon = { name: 'luxon', version: '3.7.2', dependents: ['.'] }
const abandoned = { name: 'abandoned', version: '1.0.0', dependents: ['.'] }

test('evaluateDeprecations reports a deprecated dependency as a violation', () => {
  const result = evaluateDeprecations({
    dependencies: [luxon, abandoned],
    deprecations: new Map([
      ['luxon@3.7.2', null],
      ['abandoned@1.0.0', 'no longer maintained'],
    ]),
    allowlist: new Map(),
  })

  assert.deepEqual(result.violations, [
    { ...abandoned, message: 'no longer maintained' },
  ])
  assert.deepEqual(result.tolerated, [])
  assert.deepEqual(result.stale, [])
})

test('evaluateDeprecations downgrades an allowlisted deprecation', () => {
  const entry = {
    package: 'abandoned',
    reason: 'Migration tracked',
    issue: 'https://x/1',
  }
  const result = evaluateDeprecations({
    dependencies: [abandoned],
    deprecations: new Map([['abandoned@1.0.0', 'no longer maintained']]),
    allowlist: new Map([['abandoned', entry]]),
  })

  assert.deepEqual(result.violations, [])
  assert.deepEqual(result.tolerated, [
    { ...abandoned, message: 'no longer maintained', allowance: entry },
  ])
  assert.deepEqual(result.stale, [])
})

// An allowlist entry that outlives the migration it covers would silently
// tolerate a future deprecation of the same package.
test('evaluateDeprecations reports an allowance that no longer applies as stale', () => {
  const entry = { package: 'gone', reason: 'Migration', issue: 'https://x/1' }
  const result = evaluateDeprecations({
    dependencies: [luxon],
    deprecations: new Map([['luxon@3.7.2', null]]),
    allowlist: new Map([['gone', entry]]),
  })

  assert.deepEqual(result.stale, [entry])
  assert.deepEqual(result.violations, [])
})

test('evaluateDeprecations reports a dependency without a registry answer as unchecked', () => {
  const result = evaluateDeprecations({
    dependencies: [luxon],
    deprecations: new Map(),
    allowlist: new Map(),
  })

  assert.equal(result.violations.length, 0)
  assert.deepEqual(result.unchecked, [luxon])
})

test('formatReport annotates violations as errors and stale allowances as warnings', () => {
  const report = formatReport({
    violations: [{ ...abandoned, message: 'no longer maintained' }],
    tolerated: [],
    stale: [{ package: 'gone', reason: 'Migration', issue: 'https://x/1' }],
    unchecked: [],
  })

  assert.match(report, /^::error::.*abandoned@1\.0\.0.*no longer maintained/m)
  assert.match(report, /^::warning::.*gone/m)
})

test('formatReport reports an all-clear run without annotations', () => {
  const report = formatReport({
    violations: [],
    tolerated: [],
    stale: [],
    unchecked: [],
  })

  assert.doesNotMatch(report, /^::(error|warning)::/m)
})

test('formatReport names the allowlist entry behind a tolerated deprecation', () => {
  const report = formatReport({
    violations: [],
    tolerated: [
      {
        ...abandoned,
        message: 'no longer maintained',
        allowance: {
          package: 'abandoned',
          reason: 'Migration tracked',
          issue: 'https://x/1',
        },
      },
    ],
    stale: [],
    unchecked: [],
  })

  assert.match(report, /^::notice::.*abandoned.*Migration tracked/m)
})

test('fetchDeprecations keys registry answers by name and version', async () => {
  const deprecations = await fetchDeprecations([luxon, abandoned], {
    concurrency: 2,
    lookUp: async ({ name, version }) =>
      name === 'abandoned' ? `${name}@${version} is dead` : null,
  })

  assert.deepEqual(
    [...deprecations.entries()].sort(),
    [
      ['abandoned@1.0.0', 'abandoned@1.0.0 is dead'],
      ['luxon@3.7.2', null],
    ].sort(),
  )
})

// A registry error must not read as "not deprecated": the entry is left out,
// which `evaluateDeprecations` surfaces as an unchecked dependency.
test('fetchDeprecations omits dependencies whose lookup failed', async () => {
  const deprecations = await fetchDeprecations([luxon, abandoned], {
    concurrency: 1,
    lookUp: async ({ name }) => {
      if (name === 'luxon') {
        throw new Error('registry unreachable')
      }
      return null
    },
  })

  assert.deepEqual([...deprecations.keys()], ['abandoned@1.0.0'])
})

test('the committed allowlist is valid', () => {
  assert.doesNotThrow(() => parseAllowlist(readJson(ALLOWLIST_PATH)))
})

test('the deprecation check runs on a schedule and can be dispatched manually', () => {
  const workflow = load(
    readFileSync(
      join(rootDir, '.github/workflows/deprecated-deps.yml'),
      'utf8',
    ),
  )
  const triggers = Object.keys(workflow.on)

  assert.ok(triggers.includes('schedule'), 'must run on a schedule')
  assert.ok(
    triggers.includes('workflow_dispatch'),
    'must be dispatchable so a migration can be verified on demand',
  )
  assert.ok(
    !triggers.includes('pull_request'),
    'must not run on pull requests: an upstream deprecation would then block ' +
      'every unrelated change',
  )
})
