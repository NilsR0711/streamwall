import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { lockfilePackages, readJson } from './lockfileResolution.mjs'

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))

function workspaces() {
  return readJson('package.json').workspaces
}

function declaredDependencies(manifestPath) {
  const { dependencies = {}, devDependencies = {} } = readJson(manifestPath)
  return { ...dependencies, ...devDependencies }
}

// Dependencies more than one workspace asks for. Our workspaces import each
// other's source directly (streamwall-control-client renders
// streamwall-control-ui components, both build on streamwall-shared), so a
// package they share has to be one and the same install: preact keeps hook
// state on a module-level pointer, styled-components its theme context and
// stylesheet, yjs the classes its `instanceof` checks compare against.
function sharedDependencyNames() {
  const workspacesPerName = new Map()

  for (const workspace of workspaces()) {
    for (const name of Object.keys(
      declaredDependencies(join(workspace, 'package.json')),
    )) {
      workspacesPerName.set(name, (workspacesPerName.get(name) ?? 0) + 1)
    }
  }

  return [...workspacesPerName]
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
}

// npm relocates an install whenever its version changes, and it is free to
// give each workspace its own copy of a package they all depend on rather
// than hoisting one to the root. That is what the production-dependency bump
// behind #714 did to preact and styled-components, and the two preact copies
// failed all 26 useStreamwallWebsocketConnection tests with "Cannot read
// properties of undefined (reading '__H')" — the shape a split hook-state
// pointer takes.
test('every dependency shared between workspaces is installed once, at the root', () => {
  const packages = lockfilePackages()

  for (const name of sharedDependencyNames()) {
    const perWorkspace = Object.keys(packages).filter(
      (location) =>
        location.startsWith('packages/') &&
        location.endsWith(`/node_modules/${name}`),
    )

    assert.deepEqual(
      perWorkspace,
      [],
      `"${name}" is declared by several workspaces but package-lock.json ` +
        'also installs it inside ' +
        `${perWorkspace.join(', ')}. Those workspaces then load different ` +
        'copies of the same library across an import boundary. Run ' +
        '`npm install && npm dedupe`, and declare the package in the root ' +
        'package.json if npm keeps splitting it (see #714).',
    )

    assert.ok(
      packages[`node_modules/${name}`],
      `"${name}" is declared by several workspaces but package-lock.json ` +
        'has no root node_modules entry for it, so there is no single ' +
        'hoisted copy for them to share.',
    )
  }
})

function findSourceFiles(workspace) {
  const results = []

  function walk(relativeDir) {
    let entries
    try {
      entries = readdirSync(join(rootDir, workspace, relativeDir), {
        withFileTypes: true,
      })
    } catch (err) {
      if (err.code === 'ENOENT') {
        return
      }
      throw err
    }

    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist') {
        continue
      }

      const entryRelativeDir = join(relativeDir, entry.name)
      if (entry.isDirectory()) {
        walk(entryRelativeDir)
      } else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
        results.push(join(rootDir, workspace, entryRelativeDir))
      }
    }
  }

  walk('.')
  return results
}

// `preact` and every one of its subpath entry points (`preact/hooks`,
// `preact/test-utils`, `preact/compat`, …) come out of the same installed
// copy, so importing any of them ties the workspace to that copy.
const PREACT_IMPORT = /\bfrom\s+['"]preact(\/[^'"]+)?['"]/

// The guard above only sees packages a workspace declares. streamwall and
// streamwall-control-client used to import preact without declaring it at
// all, which worked only while npm happened to hoist streamwall-control-ui's
// copy to the root — the arrangement #714 broke.
test('every workspace importing preact declares it', () => {
  for (const workspace of workspaces()) {
    const imports = findSourceFiles(workspace).some((file) =>
      PREACT_IMPORT.test(readFileSync(file, 'utf8')),
    )

    if (!imports) {
      continue
    }

    assert.ok(
      declaredDependencies(join(workspace, 'package.json')).preact,
      `${workspace} imports preact but does not declare it in its ` +
        'package.json. Add it so npm installs it for that workspace ' +
        'instead of relying on the root hoist (see #714).',
    )
  }
})
