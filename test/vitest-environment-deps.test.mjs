import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(rootDir, relativePath), 'utf8'))
}

function readDocIfExists(relativePath) {
  try {
    return readFileSync(join(rootDir, relativePath), 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') {
      return null
    }
    throw err
  }
}

function findTestFiles(workspace) {
  const results = []

  function walk(relativeDir) {
    for (const entry of readdirSync(join(rootDir, workspace, relativeDir), {
      withFileTypes: true,
    })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') {
        continue
      }

      const entryRelativeDir = join(relativeDir, entry.name)
      if (entry.isDirectory()) {
        walk(entryRelativeDir)
      } else if (/\.test\.tsx?$/.test(entry.name)) {
        results.push(join(workspace, entryRelativeDir))
      }
    }
  }

  walk('.')
  return results
}

// vitest resolves a non-default `test.environment` (e.g. happy-dom) as a
// package import, set either as a workspace-wide config default or a
// per-file `@vitest-environment` pragma comment overriding it.
function environmentFromConfig(source) {
  return source.match(/environment:\s*['"]([^'"]+)['"]/)?.[1]
}

function environmentFromPragma(source) {
  return source.match(/^\/\/\s*@vitest-environment\s+(\S+)/m)?.[1]
}

// Every vitest environment package this repo actually relies on to run its
// tests, gathered from every workspace's config and test files. `node` is
// vitest's built-in default and needs no separate package.
function requiredTestEnvironments() {
  const environments = new Set()

  for (const workspace of readJson('package.json').workspaces) {
    const config = readDocIfExists(join(workspace, 'vitest.config.ts'))
    const configEnvironment = config && environmentFromConfig(config)
    if (configEnvironment) {
      environments.add(configEnvironment)
    }

    for (const testFile of findTestFiles(workspace)) {
      const pragmaEnvironment = environmentFromPragma(readDocIfExists(testFile))
      if (pragmaEnvironment) {
        environments.add(pragmaEnvironment)
      }
    }
  }

  environments.delete('node')
  return environments
}

// vitest only declares its DOM environments (happy-dom, jsdom) as *optional
// peer* dependencies. A workspace `package.json` asking for one is not
// enough to keep it out of that optional-peer state at the root: vitest
// itself is hoisted there, resolves the environment relative to its own
// location, and npm is free to drop an optional peer nothing at the root
// explicitly requires the next time the lockfile regenerates — which is
// exactly what the find-my-way bump in #670 did, breaking every `Test` job
// with `Cannot find package 'happy-dom'` before a single assertion ran
// (fixed for that instance in #675). Declaring the environment as a root
// dependency is what turns it into a real, non-optional install.
test('every vitest environment package is declared as a root dependency', () => {
  const { dependencies = {}, devDependencies = {} } = readJson('package.json')
  const declared = { ...dependencies, ...devDependencies }

  for (const environment of requiredTestEnvironments()) {
    assert.ok(
      declared[environment],
      `"${environment}" is used as a vitest environment but is not declared ` +
        'in the root package.json. Add it to "devDependencies" so npm ' +
        'installs it as a real dependency instead of inferring it from ' +
        "vitest's optional peer dependency on it (see #676).",
    )
  }
})

// The declaration above only helps if the lockfile agrees: a stale lockfile
// can still resolve the environment purely through npm's optional-peer
// inference, which is the literal failure mode this guard exists to catch.
test('the lockfile does not resolve a required vitest environment through hoisting alone', () => {
  const { packages } = readJson('package-lock.json')

  for (const environment of requiredTestEnvironments()) {
    const entry = packages[`node_modules/${environment}`]
    assert.ok(
      entry,
      `package-lock.json has no node_modules/${environment} entry, but a ` +
        'vitest config or test file requires that environment',
    )
    assert.ok(
      !(entry.optional && entry.peer),
      `node_modules/${environment} in package-lock.json is still marked ` +
        'both "optional" and "peer", meaning npm installed it only because ' +
        'vitest declares it as an optional peer dependency, not because ' +
        'any package.json actually requires it. Run `npm install` after ' +
        'declaring it as a root dependency to regenerate the lockfile ' +
        'entry (see #676).',
    )
  }
})
