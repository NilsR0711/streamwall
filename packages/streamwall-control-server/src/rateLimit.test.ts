import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseTrustProxy } from './index.ts'
import { buildTestApp } from './testHelpers.ts'

test('rate-limits the invite auth route with a strict per-route budget', async () => {
  process.env.STREAMWALL_RATE_LIMIT_MAX = '100'
  process.env.STREAMWALL_AUTH_RATE_LIMIT_MAX = '3'
  const { app } = await buildTestApp()

  const codes: number[] = []
  for (let i = 0; i < 5; i++) {
    const res = await app.inject({
      method: 'POST',
      url: '/invite/x',
      headers: { 'content-type': 'application/json' },
      payload: { token: 'y' },
    })
    codes.push(res.statusCode)
  }

  // The first 3 reach the handler (403 for the bogus token); further requests
  // are throttled before any scrypt work happens.
  assert.deepEqual(codes.slice(0, 3), [403, 403, 403])
  assert.equal(codes[3], 429)
  assert.equal(codes[4], 429)

  await app.close()
})

test('applies a global rate limit to non-auth routes', async () => {
  process.env.STREAMWALL_RATE_LIMIT_MAX = '4'
  delete process.env.STREAMWALL_AUTH_RATE_LIMIT_MAX
  const { app } = await buildTestApp()

  const codes: number[] = []
  for (let i = 0; i < 6; i++) {
    const res = await app.inject({ method: 'GET', url: '/' })
    codes.push(res.statusCode)
  }

  assert.ok(
    codes.includes(429),
    `expected a 429 once the global budget is exceeded, got ${codes}`,
  )
  assert.equal(codes.at(-1), 429)

  await app.close()
})

test('the auth route budget is stricter than the global budget', async () => {
  process.env.STREAMWALL_RATE_LIMIT_MAX = '50'
  process.env.STREAMWALL_AUTH_RATE_LIMIT_MAX = '2'
  const { app } = await buildTestApp()

  const inviteCodes: number[] = []
  for (let i = 0; i < 4; i++) {
    const res = await app.inject({
      method: 'POST',
      url: '/invite/x',
      headers: { 'content-type': 'application/json' },
      payload: { token: 'y' },
    })
    inviteCodes.push(res.statusCode)
  }

  // Throttled well before the global budget of 50 would kick in.
  assert.equal(inviteCodes[2], 429)

  await app.close()
})

test('parseTrustProxy is off by default and accepts boolean-ish or proxy lists', () => {
  assert.equal(parseTrustProxy(undefined), false)
  assert.equal(parseTrustProxy(''), false)
  assert.equal(parseTrustProxy('true'), true)
  assert.equal(parseTrustProxy('1'), true)
  assert.equal(parseTrustProxy('false'), false)
  assert.equal(parseTrustProxy('127.0.0.1'), '127.0.0.1')
  assert.equal(parseTrustProxy('10.0.0.0/8'), '10.0.0.0/8')
})

test('with trustProxy, distinct X-Forwarded-For clients keep separate rate-limit budgets', async () => {
  process.env.STREAMWALL_RATE_LIMIT_MAX = '2'
  delete process.env.STREAMWALL_AUTH_RATE_LIMIT_MAX
  process.env.STREAMWALL_TRUST_PROXY = 'true'
  const { app } = await buildTestApp()

  for (let i = 0; i < 2; i++) {
    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: { 'x-forwarded-for': '198.51.100.10' },
    })
    assert.notEqual(res.statusCode, 429)
  }
  const exhausted = await app.inject({
    method: 'GET',
    url: '/',
    headers: { 'x-forwarded-for': '198.51.100.10' },
  })
  assert.equal(exhausted.statusCode, 429)

  // A different client IP must not share the exhausted bucket.
  const other = await app.inject({
    method: 'GET',
    url: '/',
    headers: { 'x-forwarded-for': '198.51.100.20' },
  })
  assert.notEqual(
    other.statusCode,
    429,
    'second client should not inherit the first client budget when trustProxy is on',
  )

  await app.close()
  delete process.env.STREAMWALL_TRUST_PROXY
})
