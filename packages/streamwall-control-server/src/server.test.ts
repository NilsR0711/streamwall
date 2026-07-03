import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTestApp } from './testHelpers.ts'

test('initApp builds an injectable app without listening on a port', async () => {
  const { app, cleanup } = await createTestApp()
  try {
    const res = await app.inject({ method: 'GET', url: '/does-not-exist' })
    assert.equal(res.statusCode, 404)
  } finally {
    await cleanup()
  }
})
