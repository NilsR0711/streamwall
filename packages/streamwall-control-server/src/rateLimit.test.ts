import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildTestApp } from './testHelpers.ts'

test('rate-limits the invite auth route with a strict per-route budget', async () => {
  process.env.STREAMWALL_RATE_LIMIT_MAX = '100'
  process.env.STREAMWALL_AUTH_RATE_LIMIT_MAX = '3'
  const { app } = await buildTestApp()

  const codes: number[] = []
  for (let i = 0; i < 5; i++) {
    const res = await app.inject({ method: 'GET', url: '/invite/x?token=y' })
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
    const res = await app.inject({ method: 'GET', url: '/invite/x?token=y' })
    inviteCodes.push(res.statusCode)
  }

  // Throttled well before the global budget of 50 would kick in.
  assert.equal(inviteCodes[2], 429)

  await app.close()
})
