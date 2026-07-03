import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildTestApp } from './testHelpers.ts'

test('sets baseline security response headers via helmet', async () => {
  const { app } = await buildTestApp()

  const res = await app.inject({ method: 'GET', url: '/invite/x?token=y' })

  assert.equal(res.headers['x-content-type-options'], 'nosniff')
  assert.ok(
    res.headers['content-security-policy'],
    'expected a Content-Security-Policy header',
  )
  assert.equal(
    res.headers['x-dns-prefetch-control'],
    'off',
    'expected helmet defaults to be applied',
  )

  await app.close()
})

test('keeps a CSP compatible with the served control client', async () => {
  const { app } = await buildTestApp()

  const res = await app.inject({ method: 'GET', url: '/invite/x?token=y' })
  const csp = res.headers['content-security-policy'] ?? ''

  // The client bundle relies on inline styles and same-origin resources.
  assert.match(csp, /default-src 'self'/)
  assert.match(csp, /style-src[^;]*'unsafe-inline'/)

  await app.close()
})

test('does not force upgrade-insecure-requests when serving over http', async () => {
  const { app } = await buildTestApp({ baseURL: 'http://localhost:3000' })

  const res = await app.inject({ method: 'GET', url: '/invite/x?token=y' })
  const csp = res.headers['content-security-policy'] ?? ''

  // Over plain http the WebSocket uplink is ws://; upgrade-insecure-requests
  // would rewrite it to wss:// and break the connection.
  assert.doesNotMatch(csp, /upgrade-insecure-requests/)

  await app.close()
})

test('enables upgrade-insecure-requests and HSTS when serving over https', async () => {
  const { app } = await buildTestApp({ baseURL: 'https://control.example.com' })

  const res = await app.inject({ method: 'GET', url: '/invite/x?token=y' })
  const csp = res.headers['content-security-policy'] ?? ''

  assert.match(csp, /upgrade-insecure-requests/)
  assert.ok(
    res.headers['strict-transport-security'],
    'expected HSTS header over https',
  )

  await app.close()
})
