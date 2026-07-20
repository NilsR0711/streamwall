import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import type { StreamwallRole } from 'streamwall-shared'

import { SESSION_COOKIE_NAME } from './index.ts'
import { buildTestApp } from './testHelpers.ts'
import type { UpdateChecker, UpdateStatus } from './updateCheck.ts'

/** A checker stub returning a fixed status, so the route never hits the network. */
function stubUpdateChecker(status: Partial<UpdateStatus> = {}): UpdateChecker {
  const full: UpdateStatus = {
    version: '0.9.1',
    latestVersion: '1.0.0',
    updateAvailable: true,
    releaseUrl: 'https://example.test/releases/v1.0.0',
    lastCheckedAt: '2026-07-20T00:00:00.000Z',
    checkEnabled: true,
    ...status,
  }
  return {
    getStatus: () => full,
    checkNow: async () => full,
    start: async () => {},
    stop: () => {},
  }
}

/** Builds an app and returns a session cookie header for the given role. */
async function appWithSession(
  role: StreamwallRole,
  updateChecker: UpdateChecker = stubUpdateChecker(),
) {
  const { app, auth } = await buildTestApp({ updateChecker })
  after(() => app.close())

  const { tokenId, secret } = await auth.createToken({
    kind: 'session',
    role,
    name: `${role} session`,
  })

  return { app, cookie: `${SESSION_COOKIE_NAME}=${tokenId}:${secret}` }
}

describe('GET /admin/status', () => {
  test('rejects an admin cookie minted by a different server instance', async () => {
    const { app } = await appWithSession('admin')
    const { cookie } = await appWithSession('admin')

    const response = await app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { cookie },
    })

    assert.equal(
      response.statusCode,
      403,
      'a cookie from another app must not authorize',
    )
  })

  test('serves the update status for an admin session', async () => {
    const { app, cookie } = await appWithSession('admin')

    const response = await app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { cookie },
    })

    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), {
      version: '0.9.1',
      latestVersion: '1.0.0',
      updateAvailable: true,
      releaseUrl: 'https://example.test/releases/v1.0.0',
      lastCheckedAt: '2026-07-20T00:00:00.000Z',
      checkEnabled: true,
    })
  })

  test('reports a disabled check without inventing an update', async () => {
    const { app, cookie } = await appWithSession(
      'admin',
      stubUpdateChecker({
        latestVersion: null,
        updateAvailable: false,
        releaseUrl: null,
        lastCheckedAt: null,
        checkEnabled: false,
      }),
    )

    const response = await app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { cookie },
    })

    assert.equal(response.statusCode, 200)
    assert.equal(response.json().checkEnabled, false)
    assert.equal(response.json().updateAvailable, false)
  })

  test('is denied to non-admin roles', async () => {
    for (const role of ['operator', 'monitor'] as const) {
      const { app, cookie } = await appWithSession(role)

      const response = await app.inject({
        method: 'GET',
        url: '/admin/status',
        headers: { cookie },
      })

      assert.equal(
        response.statusCode,
        403,
        `${role} must not read server status`,
      )
      assert.equal(response.body, '')
    }
  })

  test('is denied without a session cookie', async () => {
    const { app } = await appWithSession('admin')

    const response = await app.inject({ method: 'GET', url: '/admin/status' })

    assert.equal(response.statusCode, 403)
  })

  test('is denied for an invite token presented as a session cookie', async () => {
    const { app, auth } = await buildTestApp({
      updateChecker: stubUpdateChecker(),
    })
    after(() => app.close())

    const { tokenId, secret } = await auth.createToken({
      kind: 'invite',
      role: 'admin',
      name: 'invite',
    })

    const response = await app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${tokenId}:${secret}` },
    })

    assert.equal(response.statusCode, 403)
  })

  test('never caches the status response', async () => {
    const { app, cookie } = await appWithSession('admin')

    const response = await app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { cookie },
    })

    assert.match(String(response.headers['cache-control']), /no-store/)
  })
})
