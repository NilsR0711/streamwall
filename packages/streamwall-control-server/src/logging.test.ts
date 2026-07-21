import assert from 'node:assert/strict'
import { once } from 'node:events'
import { after, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'

import {
  buildTestApp,
  captureLogs,
  listenTestApp,
  mintUplinkToken,
  redeemInviteAndConnectClient,
  VALID_STATE,
} from './testHelpers.ts'

const BASE_URL = 'http://localhost:3000'

/** Pino numeric levels, for asserting on the severity of a captured entry. */
const INFO = 30
const WARN = 40

/**
 * Boots a live server whose logs are captured as parsed JSON entries, connects
 * an authenticated Streamwall uplink and seeds it with a valid state.
 */
async function bootWithCapturedLogs() {
  process.env.STREAMWALL_RATE_LIMIT_MAX = '10000'
  process.env.STREAMWALL_AUTH_RATE_LIMIT_MAX = '10000'

  const logs = captureLogs()
  const { app, auth } = await buildTestApp({ baseURL: BASE_URL, logs })
  after(() => app.close())
  const port = await listenTestApp(app)

  const { tokenId, secret, base } = await mintUplinkToken(auth, port)
  const ws = new WebSocket(base, {
    headers: { authorization: `Bearer ${secret}` },
  })
  after(() => ws.terminate())
  await once(ws, 'open')
  ws.send(JSON.stringify({ type: 'state', state: VALID_STATE }))
  await delay(150)

  return { app, auth, port, ws, logs, uplinkTokenId: tokenId }
}

test('emits structured JSON log entries with a severity level', async () => {
  const { logs } = await bootWithCapturedLogs()

  const connecting = logs.entries.find((e) => e.msg === 'Streamwall connecting')
  assert.ok(connecting, 'the uplink connection must be logged')
  assert.equal(connecting.level, INFO)
  assert.equal(connecting.role, 'admin')
  assert.ok(
    typeof connecting.reqId === 'string' ||
      typeof connecting.reqId === 'number',
    'entries must carry a request correlation id',
  )
})

test('never logs uplink token ids or token names at info level or above', async () => {
  const { logs, uplinkTokenId } = await bootWithCapturedLogs()

  const visible = logs.entries.filter((e) => Number(e.level) >= INFO)
  assert.ok(visible.length > 0, 'expected some info-level entries')
  for (const entry of visible) {
    const serialized = JSON.stringify(entry)
    assert.ok(
      !serialized.includes(uplinkTokenId),
      `token id leaked into an info-level log entry: ${serialized}`,
    )
    assert.ok(
      !serialized.includes('"uplink"'),
      `token name leaked into an info-level log entry: ${serialized}`,
    )
  }
})

test('logs only a truncated token id prefix at debug level', async () => {
  const { logs, uplinkTokenId } = await bootWithCapturedLogs()

  const debugEntry = logs.entries.find(
    (e) => typeof e.tokenIdPrefix === 'string',
  )
  assert.ok(debugEntry, 'expected a debug entry carrying a token id prefix')
  assert.ok(Number(debugEntry.level) < INFO, 'the prefix must stay at debug')
  assert.equal(debugEntry.tokenIdPrefix, uplinkTokenId.slice(0, 4))
  assert.notEqual(debugEntry.tokenIdPrefix, uplinkTokenId)
})

test('redacts the uplink token id out of logged request paths', async () => {
  const { logs, uplinkTokenId } = await bootWithCapturedLogs()

  const requestEntry = logs.entries.find(
    (e) =>
      typeof (e.req as { url?: unknown } | undefined)?.url === 'string' &&
      String((e.req as { url: string }).url).startsWith('/streamwall/'),
  )
  assert.ok(requestEntry, 'the uplink request must be logged')
  assert.equal(
    (requestEntry.req as { url: string }).url,
    '/streamwall/[redacted]/ws',
  )
  assert.ok(!JSON.stringify(requestEntry).includes(uplinkTokenId))
})

test('logs an unauthorized client command as a warning without the session name', async () => {
  const { app, auth, port, logs } = await bootWithCapturedLogs()

  const { ws: clientWs } = await redeemInviteAndConnectClient(
    app,
    auth,
    port,
    BASE_URL,
    'monitor',
  )
  clientWs.send(
    JSON.stringify({ id: 1, type: 'create-invite', role: 'admin', name: 'x' }),
  )
  await delay(150)

  const entry = logs.entries.find((e) =>
    String(e.msg).includes('Unauthorized attempt to "create-invite"'),
  )
  assert.ok(entry, 'the rejection must be logged')
  assert.equal(entry.level, WARN)
  assert.equal(entry.role, 'monitor')
  assert.equal(
    typeof entry.clientId,
    'string',
    'the entry must carry the client correlation id',
  )
  assert.ok(
    !JSON.stringify(entry).includes('"client"'),
    'the session name must not be logged',
  )
})

test('honours a log level that filters out info entries', async () => {
  const logs = captureLogs()
  const { app } = await buildTestApp({
    baseURL: BASE_URL,
    logs,
    logLevel: 'warn',
  })
  after(() => app.close())

  const response = await app.inject({ method: 'GET', url: '/admin/status' })
  assert.equal(response.statusCode, 403)
  assert.equal(
    logs.entries.filter((e) => Number(e.level) < WARN).length,
    0,
    'entries below the configured level must not be emitted',
  )
})
