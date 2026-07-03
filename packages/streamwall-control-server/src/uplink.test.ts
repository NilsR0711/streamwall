import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { describe, test } from 'node:test'
import WebSocket from 'ws'
import { createTestApp, type TestApp } from './testHelpers.ts'

interface Outcome {
  messages: string[]
  closed: boolean
}

/** Collect messages until the socket closes or the window elapses. */
function observe(ws: WebSocket, ms: number): Promise<Outcome> {
  return new Promise((resolve) => {
    const messages: string[] = []
    let done = false
    const finish = (closed: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ messages, closed })
    }
    ws.on('message', (d) => messages.push(d.toString()))
    ws.on('close', () => finish(true))
    ws.on('error', () => {
      // A rejected upgrade surfaces as an error; the close handler resolves.
    })
    const timer = setTimeout(() => finish(false), ms)
  })
}

async function listen(test: TestApp): Promise<string> {
  await test.app.listen({ port: 0, host: '127.0.0.1' })
  const { port } = test.app.server.address() as AddressInfo
  return `ws://127.0.0.1:${port}/streamwall/ws`
}

function isUnauthorized(outcome: Outcome): boolean {
  return outcome.messages.some((raw) => {
    try {
      return JSON.parse(raw).error === 'unauthorized'
    } catch {
      return false
    }
  })
}

describe('streamwall uplink authentication', () => {
  test('accepts a valid Authorization bearer credential', async () => {
    const t = await createTestApp()
    try {
      const { tokenId, secret } = await t.auth.createToken({
        kind: 'streamwall',
        role: 'admin',
        name: 'Streamwall',
      })
      const url = await listen(t)
      const ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${tokenId}:${secret}` },
      })
      const outcome = await observe(ws, 300)
      ws.close()

      assert.equal(
        isUnauthorized(outcome),
        false,
        'valid credential must not be rejected',
      )
      assert.equal(outcome.closed, false, 'connection should stay open')
    } finally {
      await t.cleanup()
    }
  })

  test('rejects a missing Authorization header', async () => {
    const t = await createTestApp()
    try {
      await t.auth.createToken({
        kind: 'streamwall',
        role: 'admin',
        name: 'Streamwall',
      })
      const url = await listen(t)
      const ws = new WebSocket(url)
      const outcome = await observe(ws, 1000)

      assert.ok(isUnauthorized(outcome), 'missing header must be unauthorized')
    } finally {
      await t.cleanup()
    }
  })

  test('rejects a wrong secret', async () => {
    const t = await createTestApp()
    try {
      const { tokenId } = await t.auth.createToken({
        kind: 'streamwall',
        role: 'admin',
        name: 'Streamwall',
      })
      const url = await listen(t)
      const ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${tokenId}:wrong-secret` },
      })
      const outcome = await observe(ws, 1000)

      assert.ok(isUnauthorized(outcome), 'wrong secret must be unauthorized')
    } finally {
      await t.cleanup()
    }
  })

  test('rejects a non-streamwall token', async () => {
    const t = await createTestApp()
    try {
      const { tokenId, secret } = await t.auth.createToken({
        kind: 'session',
        role: 'admin',
        name: 'Session',
      })
      const url = await listen(t)
      const ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${tokenId}:${secret}` },
      })
      const outcome = await observe(ws, 1000)

      assert.ok(
        isUnauthorized(outcome),
        'a non-streamwall token must be unauthorized',
      )
    } finally {
      await t.cleanup()
    }
  })
})
