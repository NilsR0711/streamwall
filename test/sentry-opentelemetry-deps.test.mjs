import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  lockfilePackages,
  readJson,
  resolvesFrom,
} from './lockfileResolution.mjs'

// `@sentry/node-core` imports this one at module scope, so a missing install
// is not a degraded-tracing warning — it is an unresolved import that kills
// the process (and the Vite/Rollup bundle) before any of our code runs.
const REQUIRED_PEER = '@opentelemetry/instrumentation'

// Every workspace that pulls in `@sentry/node-core`, which every Sentry SDK
// with a Node runtime (`@sentry/node` on the server, `@sentry/electron` in
// the main process) depends on.
function workspacesUsingSentryNode() {
  return readJson('package.json')
    .workspaces.map((workspace) => ({
      workspace,
      dependencies:
        readJson(join(workspace, 'package.json')).dependencies ?? {},
    }))
    .filter(({ dependencies }) =>
      Object.keys(dependencies).some((name) =>
        ['@sentry/node', '@sentry/electron'].includes(name),
      ),
    )
}

// `@sentry/node-core` declares its OpenTelemetry peers as *optional*, so npm
// is free to leave them out — while `@sentry/node` pulls the same package in
// as a real dependency. When npm hoists `@sentry/node-core` to the root but
// nests `@opentelemetry/instrumentation` under `@sentry/node`, the hoisted
// copy can no longer resolve its own import: the `Test`, `Package smoke` and
// `Docker build` jobs all died on `Cannot find package
// '@opentelemetry/instrumentation'` when the Sentry 10.67 bump in #687
// reshuffled exactly that. Declaring the peer ourselves pins it to the root.
test('workspaces using the Sentry Node SDK declare its OpenTelemetry peer', () => {
  const workspaces = workspacesUsingSentryNode()

  assert.ok(
    workspaces.length > 0,
    'no workspace depends on @sentry/node or @sentry/electron anymore — ' +
      'drop this guard along with the now-unused ' +
      `"${REQUIRED_PEER}" dependencies`,
  )

  for (const { workspace, dependencies } of workspaces) {
    assert.ok(
      dependencies[REQUIRED_PEER],
      `${workspace}/package.json depends on the Sentry Node SDK but not on ` +
        `"${REQUIRED_PEER}". @sentry/node-core imports that package at ` +
        'module scope while declaring it only as an optional peer, so it ' +
        'has to be declared here to survive a lockfile regeneration ' +
        '(see #687).',
    )
  }
})

// Where npm puts `@sentry/node-core` is not ours to decide: it lands at the
// root while a workspace pulls it in transitively, and moves into
// `packages/<name>/node_modules` as soon as two workspaces want different
// versions — which is what the @sentry/electron 7.17 bump did. So rather
// than pinning a location, assert the property that actually matters: from
// wherever each copy sits, Node's upward `node_modules` walk has to find the
// peer. That is precisely what failed in #687.
test('every installed @sentry/node-core can resolve the OpenTelemetry peer', () => {
  const packages = lockfilePackages()

  const locations = Object.keys(packages).filter((location) =>
    location.endsWith('node_modules/@sentry/node-core'),
  )

  assert.ok(
    locations.length > 0,
    'package-lock.json installs no @sentry/node-core at all, although a ' +
      'workspace depends on the Sentry Node SDK. Run `npm install` to ' +
      'regenerate the lockfile.',
  )

  for (const location of locations) {
    assert.ok(
      resolvesFrom(packages, location, REQUIRED_PEER),
      `${location} cannot resolve "${REQUIRED_PEER}": no copy of it exists ` +
        'in any node_modules directory above it that npm installed for a ' +
        'real dependency rather than as an optional peer. Declare it ' +
        'alongside the Sentry SDK and run `npm install` (see #687).',
    )
  }
})
