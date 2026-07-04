import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'
import { buildTestApp } from './testHelpers.ts'

async function startStreamwallSocket(env: Record<string, string>) {
  process.env.STREAMWALL_RATE_LIMIT_MAX = '1000'
  Object.assign(process.env, env)

  const { app, auth } = await buildTestApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const { port } = app.server.address() as AddressInfo

  const { tokenId, secret } = await auth.createToken({
    kind: 'streamwall',
    role: 'admin',
    name: 'test',
  })

  const ws = new WebSocket(`ws://127.0.0.1:${port}/streamwall/${tokenId}/ws`, {
    headers: { authorization: `Bearer ${secret}` },
  })
  await once(ws, 'open')

  return { app, ws }
}

test('closes a streamwall socket that floods messages beyond the burst', async () => {
  const { app, ws } = await startStreamwallSocket({
    STREAMWALL_WS_MSG_BURST: '5',
    STREAMWALL_WS_MSG_RATE: '1',
  })

  const closed = once(ws, 'close', { signal: AbortSignal.timeout(3000) })
  for (let i = 0; i < 50; i++) {
    ws.send(JSON.stringify({ type: 'noop', i }))
  }

  const [code] = await closed
  assert.equal(code, 1008, 'expected a policy-violation close code')

  ws.terminate()
  await app.close()
})

test('keeps a streamwall socket open for traffic within the allowance', async () => {
  const { app, ws } = await startStreamwallSocket({
    STREAMWALL_WS_MSG_BURST: '10',
    STREAMWALL_WS_MSG_RATE: '5',
  })

  for (let i = 0; i < 3; i++) {
    ws.send(JSON.stringify({ type: 'noop', i }))
  }
  await delay(250)

  assert.equal(ws.readyState, WebSocket.OPEN)

  ws.terminate()
  await app.close()
})
