import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  lockfilePackages,
  readJson,
  resolvesFrom,
} from './lockfileResolution.mjs'

// Every `@fastify/*` plugin we use augments the `fastify` module with the
// decorators it adds — `reply.setCookie`, `request.cookies`, the `websocket`
// route option and the `(socket, request)` handler signature it implies.
// TypeScript only merges such a `declare module 'fastify'` into the copy of
// fastify that the *plugin* resolves, so a plugin sitting at the root while
// fastify sits inside a workspace silently loses every decorator: the fastify
// 5.12 bump moved fastify into packages/streamwall-control-server and left the
// plugins behind, and the control-server typecheck failed with ~40 errors like
// "Property 'setCookie' does not exist on type 'FastifyReply'".
const SERVER_WORKSPACE = 'packages/streamwall-control-server'

test('every @fastify plugin resolves the same fastify it augments', () => {
  const packages = lockfilePackages()

  const pluginNames = Object.keys(
    readJson(`${SERVER_WORKSPACE}/package.json`).dependencies ?? {},
  ).filter((name) => name.startsWith('@fastify/'))

  assert.ok(
    pluginNames.length > 0,
    `${SERVER_WORKSPACE} depends on no @fastify plugin anymore — drop this ` +
      'guard along with the root fastify declaration it asks for',
  )

  const plugins = pluginNames.map((name) => {
    const location = resolvesFrom(packages, SERVER_WORKSPACE, name)
    assert.ok(
      location,
      `package-lock.json installs no ${name}, although ${SERVER_WORKSPACE} ` +
        'depends on it. Run `npm install` to regenerate the lockfile.',
    )
    return location
  })

  const consumers = [
    ...plugins,
    // The workspace whose code the augmented types have to hold for.
    SERVER_WORKSPACE,
  ]

  const resolutions = new Map(
    consumers.map((consumer) => [
      consumer,
      resolvesFrom(packages, consumer, 'fastify'),
    ]),
  )

  for (const [consumer, resolution] of resolutions) {
    assert.ok(
      resolution,
      `${consumer} cannot resolve fastify at all. Run \`npm install\` to ` +
        'regenerate the lockfile.',
    )
  }

  assert.equal(
    new Set(resolutions.values()).size,
    1,
    'the @fastify plugins and the control server do not all resolve the ' +
      'same fastify install, so a plugin augments a copy nothing else uses: ' +
      `${JSON.stringify(Object.fromEntries(resolutions))}`,
  )
})

// The hoist above is not something npm guarantees on its own: it relocates an
// install whenever the version changes, and the control server is the only
// workspace asking for fastify. A root declaration is what keeps the copy at
// the root where the plugins can see it — the same anchor happy-dom needed in
// #675 and preact in #714.
test('the root package.json anchors fastify at the root', () => {
  const { dependencies = {}, devDependencies = {} } = readJson('package.json')

  assert.ok(
    dependencies.fastify ?? devDependencies.fastify,
    'the root package.json does not declare fastify. Without it npm is free ' +
      'to move fastify into packages/streamwall-control-server on the next ' +
      'version bump, cutting the root-level @fastify plugins off from the ' +
      'module they augment.',
  )
})
