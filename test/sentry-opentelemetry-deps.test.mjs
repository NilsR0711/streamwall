import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))

// `@sentry/node-core` imports this one at module scope, so a missing install
// is not a degraded-tracing warning — it is an unresolved import that kills
// the process (and the Vite/Rollup bundle) before any of our code runs.
const REQUIRED_PEER = '@opentelemetry/instrumentation'

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(rootDir, relativePath), 'utf8'))
}

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

// The declaration above only helps if the lockfile agrees: npm may still
// resolve the package through a nested copy that the hoisted
// `@sentry/node-core` cannot reach.
test('the lockfile installs the OpenTelemetry peer at the root', () => {
  const { packages } = readJson('package-lock.json')
  const entry = packages[`node_modules/${REQUIRED_PEER}`]

  assert.ok(
    entry,
    `package-lock.json has no node_modules/${REQUIRED_PEER} entry, so the ` +
      'hoisted @sentry/node-core cannot resolve it. Run `npm install` to ' +
      'regenerate the lockfile.',
  )
  assert.ok(
    !(entry.optional && entry.peer),
    `node_modules/${REQUIRED_PEER} in package-lock.json is still marked ` +
      'both "optional" and "peer", meaning npm installed it only because ' +
      'Sentry declares it as an optional peer dependency — the next ' +
      'lockfile regeneration is free to drop it again.',
  )
})
