import assert from 'node:assert/strict'
import { once } from 'node:events'
import { after, describe, test } from 'node:test'
import WebSocket from 'ws'

import { SESSION_COOKIE_NAME } from './index.ts'
import {
  buildTestApp,
  listenTestApp,
  messageCollector,
  mintUplinkToken,
  setEnvForTest,
  TEST_BASE_URL,
} from './testHelpers.ts'

/**
 * Wraps `auth.validateToken` so a spec can count how many scrypt derivations a
 * request actually costs. The wrapper is installed on the same instance the
 * routes hold, so it sees every call they make.
 */
function countDerivations(auth: { validateToken: unknown }) {
  const real = (
    auth.validateToken as (id: string, secret: string) => Promise<unknown>
  ).bind(auth)
  const counter = { calls: 0 }
  auth.validateToken = async (id: string, secret: string) => {
    counter.calls += 1
    return real(id, secret)
  }
  return counter
}

/** Builds an app plus a valid session cookie header for it. */
async function appWithSession(overrides = {}) {
  const { app, auth } = await buildTestApp(overrides)
  after(() => app.close())
  const { tokenId, secret } = await auth.createToken({
    kind: 'session',
    role: 'admin',
    name: 'session',
  })
  return {
    app,
    auth,
    tokenId,
    cookie: `${SESSION_COOKIE_NAME}=${tokenId}:${secret}`,
  }
}

describe('scrypt-bearing routes', () => {
  test('a static asset never costs a scrypt derivation, cookie or not', async () => {
    const { app, auth, cookie } = await appWithSession()
    const derivations = countDerivations(auth)

    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/',
        headers: { cookie },
      })
      assert.equal(res.statusCode, 200)
    }

    assert.equal(
      derivations.calls,
      0,
      'serving the control client must not verify the session cookie',
    )
  })

  test('static assets are not throttled by the strict auth budget', async () => {
    // The strict budget is sized for scrypt work; a page load pulls far more
    // assets than that, so it must stay on the global budget.
    setEnvForTest({
      STREAMWALL_RATE_LIMIT_MAX: '100',
      STREAMWALL_AUTH_RATE_LIMIT_MAX: '2',
    })
    const { app, cookie } = await appWithSession()

    for (let i = 0; i < 6; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/',
        headers: { cookie },
      })
      assert.notEqual(res.statusCode, 429, `request ${i} must not be throttled`)
    }
  })

  test('an unauthenticated cookie probe against /admin/status runs out of budget', async () => {
    setEnvForTest({
      STREAMWALL_RATE_LIMIT_MAX: '100',
      STREAMWALL_AUTH_RATE_LIMIT_MAX: '3',
    })
    const { app, auth } = await buildTestApp()
    after(() => app.close())
    const derivations = countDerivations(auth)

    const codes: number[] = []
    for (let i = 0; i < 6; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/status',
        headers: { cookie: `${SESSION_COOKIE_NAME}=aaaaaaaa:bbbb` },
      })
      codes.push(res.statusCode)
    }

    assert.deepEqual(
      codes.slice(0, 3),
      [403, 403, 403],
      'the budget must be spent before throttling starts',
    )
    assert.deepEqual(codes.slice(3), [429, 429, 429])
    assert.equal(
      derivations.calls,
      3,
      'a throttled probe must be refused before any scrypt work',
    )
  })

  test('a valid session is verified once and then served from cache', async () => {
    const { app, auth, cookie } = await appWithSession()
    const derivations = countDerivations(auth)

    for (let i = 0; i < 4; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/status',
        headers: { cookie },
      })
      assert.equal(res.statusCode, 200)
    }

    assert.equal(
      derivations.calls,
      1,
      'repeated requests on one session must not re-derive the token hash',
    )
  })

  test('a revoked session stops being accepted immediately', async () => {
    const { app, auth, tokenId, cookie } = await appWithSession()

    const accepted = await app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { cookie },
    })
    assert.equal(accepted.statusCode, 200)

    auth.deleteToken(tokenId)

    const refused = await app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { cookie },
    })
    assert.equal(
      refused.statusCode,
      403,
      'a cached verification must not outlive the token it verified',
    )
  })

  test('a repeated session cookie keeps reconnecting past the strict budget', async () => {
    // Operators behind one NAT share an IP; their reconnects cost no scrypt
    // once the session is known, so they must not spend the strict budget.
    setEnvForTest({
      STREAMWALL_RATE_LIMIT_MAX: '100',
      STREAMWALL_AUTH_RATE_LIMIT_MAX: '2',
    })
    const { app, cookie } = await appWithSession()
    const port = await listenTestApp(app)

    for (let i = 0; i < 5; i++) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/client/ws`, {
        headers: { Cookie: cookie, Origin: TEST_BASE_URL },
      })
      const nextMessage = messageCollector(ws)
      await once(ws, 'open')
      // No uplink is connected, so the server answers with that — which is
      // proof the socket got past both the limiter and the auth check.
      assert.deepEqual(await nextMessage(1000), {
        error: 'streamwall disconnected',
      })
      ws.terminate()
    }
  })

  test('the uplink route is throttled before it derives', async () => {
    setEnvForTest({
      STREAMWALL_RATE_LIMIT_MAX: '100',
      STREAMWALL_AUTH_RATE_LIMIT_MAX: '2',
    })
    const { app, auth } = await buildTestApp()
    after(() => app.close())
    const port = await listenTestApp(app)
    const { base } = await mintUplinkToken(auth, port)
    const derivations = countDerivations(auth)

    const outcomes: string[] = []
    for (let i = 0; i < 4; i++) {
      const ws = new WebSocket(base, {
        headers: { authorization: 'Bearer wrong-secret' },
      })
      ws.on('error', () => {})
      const outcome = await Promise.race([
        once(ws, 'open').then(() => 'open'),
        once(ws, 'unexpected-response').then(
          (args) => `http-${(args[1] as { statusCode: number }).statusCode}`,
        ),
      ])
      outcomes.push(outcome)
      ws.terminate()
    }

    assert.deepEqual(
      outcomes.slice(2),
      ['http-429', 'http-429'],
      'the uplink handshake must be throttled once the strict budget is spent',
    )
    assert.equal(
      derivations.calls,
      2,
      'a throttled handshake must be refused before any scrypt work',
    )
  })
})
