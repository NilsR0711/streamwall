import assert from 'node:assert/strict'
import { once } from 'node:events'
import { after, describe, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'

import { SESSION_COOKIE_NAME } from './index.ts'
import {
  bootServerWithUplink,
  buildTestApp,
  captureLogs,
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

  test('a spent strict budget never locks a known session out of its socket', async () => {
    // Operators behind one NAT share an IP with whoever else is on it. Their
    // reconnects cost no scrypt once the session is known, so an attacker
    // spraying unknown cookies from that address must not be able to shut them
    // out by exhausting the strict budget.
    setEnvForTest({
      STREAMWALL_RATE_LIMIT_MAX: '100',
      STREAMWALL_AUTH_RATE_LIMIT_MAX: '2',
    })
    const { app, cookie } = await appWithSession()
    const port = await listenTestApp(app)

    // Warm the session, then let the attacker burn the strict budget.
    const warmup = await app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { cookie },
    })
    assert.equal(warmup.statusCode, 200)
    for (let i = 0; i < 4; i++) {
      await app.inject({
        method: 'GET',
        url: '/admin/status',
        headers: { cookie: `${SESSION_COOKIE_NAME}=aaaaaaaa:bbbb${i}` },
      })
    }
    const sprayed = await app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { cookie: `${SESSION_COOKIE_NAME}=aaaaaaaa:cccc` },
    })
    assert.equal(
      sprayed.statusCode,
      429,
      'the strict budget must be spent for this spec to mean anything',
    )

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

  test('the uplink credential is never accepted as a browser session', async () => {
    // Both credentials are verified through the same cache. If a hit ignored
    // which kind was asked for, presenting the desktop's bearer token as an
    // `s` cookie would inherit its admin authority on the browser surface.
    const logs = captureLogs()
    const { app, auth } = await buildTestApp({ logs })
    after(() => app.close())
    const port = await listenTestApp(app)
    const { base, secret, tokenId } = await mintUplinkToken(auth, port)

    const uplink = new WebSocket(base, {
      headers: { authorization: `Bearer ${secret}` },
    })
    after(() => uplink.terminate())
    await once(uplink, 'open')
    // The client's `open` only means the socket upgraded; wait for the server
    // to have finished verifying the bearer token, which is what puts it in
    // the shared cache this spec is about.
    await logs.waitForMessage('Streamwall connecting')

    const derivations = countDerivations(auth)
    const asSession = await app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${tokenId}:${secret}` },
    })
    assert.equal(
      asSession.statusCode,
      403,
      'an uplink token must carry no authority on the client surface',
    )
    assert.equal(
      derivations.calls,
      1,
      'the uplink entry must not even be consulted for a session lookup',
    )
  })

  test('tabs reconnecting together on a known session are not throttled', async () => {
    // When the uplink drops, the server closes every client socket at once and
    // they all retry. Their session was verified when they connected, so the
    // herd costs no scrypt at all and must not touch the strict budget.
    setEnvForTest({
      STREAMWALL_RATE_LIMIT_MAX: '100',
      STREAMWALL_AUTH_RATE_LIMIT_MAX: '2',
    })
    const { app, auth, cookie } = await appWithSession()
    const warmup = await app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { cookie },
    })
    assert.equal(warmup.statusCode, 200)
    const derivations = countDerivations(auth)

    const codes = await Promise.all(
      Array.from({ length: 6 }, () =>
        app
          .inject({
            method: 'GET',
            url: '/admin/status',
            headers: { cookie },
          })
          .then((res) => res.statusCode),
      ),
    )

    assert.deepEqual(
      codes,
      [200, 200, 200, 200, 200, 200],
      'a burst on one valid session must not be throttled',
    )
    assert.equal(
      derivations.calls,
      0,
      'a known session must cost no derivation at all',
    )
  })

  test('an open client socket keeps its session verification warm', async () => {
    // A connected browser makes no further requests, so without a refresh its
    // entry would expire and the reconnect after an uplink flap would derive.
    const { app, auth, port } = await bootServerWithUplink({
      clientPing: { intervalMs: 20, timeoutMs: 1000 },
      verifiedTokenTtlMs: 60,
    })

    const invite = await auth.createToken({
      kind: 'invite',
      role: 'admin',
      name: 'client',
    })
    const redeem = await app.inject({
      method: 'POST',
      url: `/invite/${invite.tokenId}`,
      headers: { 'content-type': 'application/json' },
      payload: { token: invite.secret },
    })
    const rawCookie = redeem.headers['set-cookie']
    const cookie = (
      Array.isArray(rawCookie) ? rawCookie[0] : String(rawCookie)
    ).split(';')[0]

    const ws = new WebSocket(`ws://127.0.0.1:${port}/client/ws`, {
      headers: { Cookie: cookie, Origin: TEST_BASE_URL },
    })
    after(() => ws.terminate())
    await once(ws, 'open')
    await messageCollector(ws)(500)

    // Well past the TTL, but inside the refresh cadence.
    await delay(300)
    const derivations = countDerivations(auth)
    const res = await app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { cookie },
    })

    assert.equal(res.statusCode, 200)
    assert.equal(
      derivations.calls,
      0,
      'the session must still be verified without deriving again',
    )
  })

  test('a request without a cookie never spends the strict budget', async () => {
    // Nothing is verified without a cookie, so such a request costs no scrypt.
    // A logged-out tab retrying its socket would otherwise spend the whole
    // budget and lock out the operator logging in from the same address.
    setEnvForTest({
      STREAMWALL_RATE_LIMIT_MAX: '100',
      STREAMWALL_AUTH_RATE_LIMIT_MAX: '2',
    })
    const { app, cookie } = await appWithSession()

    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'GET', url: '/admin/status' })
      assert.equal(res.statusCode, 403, 'no cookie means no identity')
    }

    const authenticated = await app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { cookie },
    })
    assert.equal(
      authenticated.statusCode,
      200,
      'a first real login must still have budget left',
    )
  })

  test('a reconnecting uplink is not throttled on its own verified token', async () => {
    // The desktop retries every few seconds through a flapping link, well
    // above the strict budget — on a token the server verified moments ago.
    setEnvForTest({
      STREAMWALL_RATE_LIMIT_MAX: '100',
      STREAMWALL_AUTH_RATE_LIMIT_MAX: '2',
    })
    const { app, auth } = await buildTestApp()
    after(() => app.close())
    const port = await listenTestApp(app)
    const { base, secret } = await mintUplinkToken(auth, port)

    for (let i = 0; i < 5; i++) {
      const ws = new WebSocket(base, {
        headers: { authorization: `Bearer ${secret}` },
      })
      ws.on('error', () => {})
      await once(ws, 'open')
      ws.terminate()
      // The slot is released on close; wait for that before reconnecting.
      await once(ws, 'close')
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
