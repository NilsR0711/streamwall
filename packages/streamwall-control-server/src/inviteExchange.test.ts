import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'

import { SESSION_COOKIE_NAME } from './index.ts'
import { buildTestApp } from './testHelpers.ts'

async function appWithInvite(role = 'admin' as const) {
  const { app, auth } = await buildTestApp()
  after(() => app.close())
  const { tokenId, secret } = await auth.createToken({
    kind: 'invite',
    role,
    name: 'Test invite',
  })
  return { app, auth, tokenId, secret }
}

function postInvite(
  app: Awaited<ReturnType<typeof appWithInvite>>['app'],
  tokenId: string,
  token: string,
) {
  return app.inject({
    method: 'POST',
    url: `/invite/${tokenId}`,
    headers: { 'content-type': 'application/json' },
    payload: { token },
  })
}

describe('invite redemption keeps the secret out of the URL', () => {
  test('GET /invite/:id serves an exchange page that carries no secret', async () => {
    const { app, tokenId, secret } = await appWithInvite()

    const res = await app.inject({ method: 'GET', url: `/invite/${tokenId}` })

    assert.equal(res.statusCode, 200)
    assert.match(String(res.headers['content-type']), /text\/html/)
    assert.equal(
      res.body.includes(secret),
      false,
      'the server never sees the secret, so the page cannot contain it',
    )
    assert.match(
      res.body,
      /invite-exchange\.js/,
      'the page loads the client exchange script',
    )
    assert.equal(
      res.headers['set-cookie'],
      undefined,
      'a bare GET must not start a session',
    )
  })

  test('GET /invite/:id ignores a legacy ?token= query and sets no cookie', async () => {
    const { app, tokenId, secret } = await appWithInvite()

    const res = await app.inject({
      method: 'GET',
      url: `/invite/${tokenId}?token=${secret}`,
    })

    assert.equal(res.statusCode, 200)
    assert.equal(
      res.headers['set-cookie'],
      undefined,
      'the query-string token path must no longer authenticate',
    )
  })

  test('the invite page CSP permits the exchange script and its POST', async () => {
    const { app, tokenId } = await appWithInvite()

    const res = await app.inject({ method: 'GET', url: `/invite/${tokenId}` })
    const csp = String(res.headers['content-security-policy'] ?? '')

    // The exchange page loads a same-origin script and POSTs same-origin, with
    // no inline script. These directives must keep allowing that.
    assert.match(
      csp,
      /script-src[^;]*'self'/,
      'exchange script must be allowed',
    )
    assert.match(
      csp,
      /connect-src[^;]*'self'/,
      'the redeem POST must be allowed',
    )
    assert.equal(
      res.body.includes('<script>'),
      false,
      'the page must have no inline script (blocked by script-src)',
    )
  })

  test('GET /invite-exchange.js serves the client exchange script', async () => {
    const { app } = await appWithInvite()

    const res = await app.inject({ method: 'GET', url: '/invite-exchange.js' })

    assert.equal(res.statusCode, 200)
    assert.match(String(res.headers['content-type']), /javascript/)
    assert.match(res.body, /location\.hash/)
    assert.match(res.body, /fetch\(/)
  })

  test('POST /invite/:id redeems a valid token and starts a session', async () => {
    const { app, tokenId, secret } = await appWithInvite()

    const res = await postInvite(app, tokenId, secret)

    assert.equal(res.statusCode, 204)
    const setCookie = String(res.headers['set-cookie'] ?? '')
    assert.match(setCookie, new RegExp(`^${SESSION_COOKIE_NAME}=`))
    assert.match(setCookie, /HttpOnly/i)
    assert.match(setCookie, /SameSite=Strict/i)
  })

  test('POST /invite/:id consumes the invite (single use)', async () => {
    const { app, tokenId, secret } = await appWithInvite()

    const first = await postInvite(app, tokenId, secret)
    assert.equal(first.statusCode, 204)

    const second = await postInvite(app, tokenId, secret)
    assert.equal(second.statusCode, 403, 'a redeemed invite cannot be reused')
    assert.equal(second.headers['set-cookie'], undefined)
  })

  test('POST /invite/:id rejects a wrong secret without a cookie', async () => {
    const { app, tokenId } = await appWithInvite()

    const res = await postInvite(app, tokenId, 'not-the-secret')

    assert.equal(res.statusCode, 403)
    assert.equal(res.headers['set-cookie'], undefined)
  })

  test('POST /invite/:id rejects a non-invite token kind', async () => {
    const { app, auth } = await appWithInvite()
    const { tokenId, secret } = await auth.createToken({
      kind: 'session',
      role: 'admin',
      name: 'A session',
    })

    const res = await postInvite(app, tokenId, secret)

    assert.equal(res.statusCode, 403)
    assert.equal(res.headers['set-cookie'], undefined)
  })

  test('POST /invite/:id rejects a missing token body', async () => {
    const { app, tokenId } = await appWithInvite()

    const res = await app.inject({
      method: 'POST',
      url: `/invite/${tokenId}`,
      headers: { 'content-type': 'application/json' },
      payload: {},
    })

    assert.equal(res.statusCode, 403)
    assert.equal(res.headers['set-cookie'], undefined)
  })
})
