import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { inviteLink } from 'streamwall-shared'
import { SESSION_COOKIE_NAME } from './index.ts'
import { createTestApp } from './testHelpers.ts'

describe('inviteLink', () => {
  test('carries the secret in the URL fragment, never the query string', () => {
    const link = inviteLink({
      baseURL: 'https://host',
      tokenId: 'abc',
      secret: 's3cr3t',
    })
    assert.equal(link, 'https://host/invite/abc#s3cr3t')
    assert.ok(!link.includes('?'), 'secret must not be in a query string')
  })
})

describe('GET /invite/:id (acceptance page)', () => {
  test('serves a JS exchange page with no secret and hardened headers', async () => {
    const { app, cleanup } = await createTestApp()
    try {
      const res = await app.inject({ method: 'GET', url: '/invite/whatever' })
      assert.equal(res.statusCode, 200)
      assert.match(res.headers['content-type'] as string, /text\/html/)
      assert.equal(res.headers['referrer-policy'], 'no-referrer')

      const csp = res.headers['content-security-policy'] as string
      assert.ok(csp, 'a Content-Security-Policy must be set')
      assert.match(csp, /script-src 'nonce-/)

      // The page reads the fragment client-side and exchanges it via POST.
      assert.match(res.body, /location\.hash/)
      assert.match(res.body, /fetch\(/)
      assert.match(res.body, /<noscript>/)
    } finally {
      await cleanup()
    }
  })
})

describe('POST /invite/:id (exchange)', () => {
  async function makeInvite(
    auth: Awaited<ReturnType<typeof createTestApp>>['auth'],
  ) {
    return auth.createToken({ kind: 'invite', role: 'operator', name: 'Op' })
  }

  test('exchanges a valid same-origin secret for a session cookie', async () => {
    const t = await createTestApp()
    try {
      const { tokenId, secret } = await makeInvite(t.auth)
      const res = await t.app.inject({
        method: 'POST',
        url: `/invite/${tokenId}`,
        headers: { origin: new URL(t.baseURL).origin },
        payload: { secret },
      })
      assert.equal(res.statusCode, 204)
      const cookie = res.headers['set-cookie']
      assert.ok(cookie, 'a session cookie must be set')
      assert.match(String(cookie), new RegExp(`${SESSION_COOKIE_NAME}=`))
      assert.match(String(cookie), /HttpOnly/i)
    } finally {
      await t.cleanup()
    }
  })

  test('rejects a second use of the same (now consumed) invite', async () => {
    const t = await createTestApp()
    try {
      const { tokenId, secret } = await makeInvite(t.auth)
      const origin = new URL(t.baseURL).origin
      const first = await t.app.inject({
        method: 'POST',
        url: `/invite/${tokenId}`,
        headers: { origin },
        payload: { secret },
      })
      assert.equal(first.statusCode, 204)

      const second = await t.app.inject({
        method: 'POST',
        url: `/invite/${tokenId}`,
        headers: { origin },
        payload: { secret },
      })
      assert.equal(second.statusCode, 403)
    } finally {
      await t.cleanup()
    }
  })

  test('rejects a wrong secret', async () => {
    const t = await createTestApp()
    try {
      const { tokenId } = await makeInvite(t.auth)
      const res = await t.app.inject({
        method: 'POST',
        url: `/invite/${tokenId}`,
        headers: { origin: new URL(t.baseURL).origin },
        payload: { secret: 'not-the-secret' },
      })
      assert.equal(res.statusCode, 403)
    } finally {
      await t.cleanup()
    }
  })

  test('rejects a cross-origin request', async () => {
    const t = await createTestApp()
    try {
      const { tokenId, secret } = await makeInvite(t.auth)
      const res = await t.app.inject({
        method: 'POST',
        url: `/invite/${tokenId}`,
        headers: { origin: 'https://evil.example.com' },
        payload: { secret },
      })
      assert.equal(res.statusCode, 403)
    } finally {
      await t.cleanup()
    }
  })

  test('rejects a missing secret', async () => {
    const t = await createTestApp()
    try {
      const { tokenId } = await makeInvite(t.auth)
      const res = await t.app.inject({
        method: 'POST',
        url: `/invite/${tokenId}`,
        headers: { origin: new URL(t.baseURL).origin },
        payload: {},
      })
      assert.equal(res.statusCode, 403)
    } finally {
      await t.cleanup()
    }
  })
})
