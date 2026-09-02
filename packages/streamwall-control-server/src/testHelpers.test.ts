import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import process from 'node:process'
import { test } from 'node:test'
import type WebSocket from 'ws'

import { DEFAULT_SCRYPT_PARAMS } from './auth.ts'
import {
  captureLogs,
  messageCollector,
  setEnvForTest,
  startTestServer,
  TEST_SCRYPT_PARAMS,
} from './testHelpers.ts'

/**
 * A minimal stand-in for a `ws` socket: `messageCollector` only ever calls
 * `.on('message', ...)` and `.off('message', ...)`, both satisfied by a plain
 * `EventEmitter`.
 */
function fakeSocket() {
  const emitter = new EventEmitter()
  return {
    ws: emitter as unknown as WebSocket,
    emitMessage: (data: string, isBinary = false) =>
      emitter.emit('message', Buffer.from(data), isBinary),
  }
}

/** Snapshot taken before any override, so the restore assertion is exact. */
const RATE_LIMIT_MAX_AT_LOAD = process.env.STREAMWALL_RATE_LIMIT_MAX

/** Serializes a log entry the way pino writes it to the capture stream. */
function line(msg: string, fields: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ level: 30, msg, ...fields })}\n`
}

test('captureLogs waitForMessage resolves with an already captured entry', async () => {
  const logs = captureLogs()
  logs.stream.write(line('Streamwall connected'))

  const entry = await logs.waitForMessage('Streamwall connected')

  assert.equal(entry.msg, 'Streamwall connected')
})

test('captureLogs waitForMessage resolves once a later entry arrives', async () => {
  const logs = captureLogs()
  const pending = logs.waitForMessage('Client connected')

  setTimeout(() => logs.stream.write(line('Client connected')), 5)

  assert.equal((await pending).msg, 'Client connected')
})

test('captureLogs waitForMessage matches a substring of the message', async () => {
  const logs = captureLogs()
  logs.stream.write(line('Unauthorized attempt to "create-invite"'))

  const entry = await logs.waitForMessage('create-invite')

  assert.equal(entry.msg, 'Unauthorized attempt to "create-invite"')
})

test('captureLogs waitFor rejects with a bounded timeout instead of hanging', async () => {
  const logs = captureLogs()

  await assert.rejects(
    () => logs.waitFor((entry) => entry.msg === 'never logged', 20),
    /timed out waiting for matching log entry/,
  )
})

test('captureLogs waitFor keeps other waiters pending when one resolves', async () => {
  const logs = captureLogs()
  const connected = logs.waitFor((entry) => entry.msg === 'Client connected')
  const disconnected = logs.waitFor(
    (entry) => entry.msg === 'Client disconnected',
    50,
  )

  logs.stream.write(line('Client connected'))
  await connected

  await assert.rejects(() => disconnected)
})

test('captureLogs waitFor exposes the matched entry fields', async () => {
  const logs = captureLogs()
  logs.stream.write(line('Client connected', { role: 'monitor' }))

  const entry = await logs.waitFor((e) => e.msg === 'Client connected')

  assert.equal(entry.role, 'monitor')
})

test('tests derive token hashes with a cheaper work factor than production', () => {
  // The whole point of the injected parameters: a live-server suite must not
  // pay the production cost, while production keeps it.
  assert.ok(TEST_SCRYPT_PARAMS.N < DEFAULT_SCRYPT_PARAMS.N)
})

test('setEnvForTest applies the requested values for the running test', () => {
  setEnvForTest({
    STREAMWALL_RATE_LIMIT_MAX: '4242',
    STREAMWALL_RATE_LIMIT_WINDOW: undefined,
  })

  assert.equal(process.env.STREAMWALL_RATE_LIMIT_MAX, '4242')
  assert.equal(process.env.STREAMWALL_RATE_LIMIT_WINDOW, undefined)
})

test('setEnvForTest restores the previous values after the test that set them', () => {
  // Guards the whole point of the helper: the override above must not have
  // leaked into this test, nor into any later file.
  assert.equal(process.env.STREAMWALL_RATE_LIMIT_MAX, RATE_LIMIT_MAX_AT_LOAD)
})

test('startTestServer merges a partial rateLimit override with the wide test defaults', async () => {
  // Only authMax is overridden; globalMax must still come from
  // WIDE_RATE_LIMITS rather than silently falling back to the production
  // default merely because the caller set an unrelated field.
  const { app } = await startTestServer({ rateLimit: { authMax: 2 } })

  const globalCodes: number[] = []
  for (let i = 0; i < 150; i++) {
    const res = await app.inject({ method: 'GET', url: '/' })
    globalCodes.push(res.statusCode)
  }
  assert.ok(
    !globalCodes.includes(429),
    `expected no 429s under the wide global budget (150 < 10000), got: ${globalCodes.join(',')}`,
  )

  // The override itself must still take effect.
  const authCodes: number[] = []
  for (let i = 0; i < 3; i++) {
    const res = await app.inject({
      method: 'POST',
      url: '/invite/x',
      headers: { 'content-type': 'application/json' },
      payload: { token: 'y' },
    })
    authCodes.push(res.statusCode)
  }
  assert.equal(
    authCodes[2],
    429,
    `expected the overridden authMax of 2 to apply, got: ${authCodes.join(',')}`,
  )
})

test('messageCollector resolves with the first JSON frame it receives', async () => {
  const { ws, emitMessage } = fakeSocket()
  const nextMessage = messageCollector(ws)

  emitMessage(JSON.stringify({ error: 'unauthorized' }))

  assert.deepEqual(await nextMessage(500), { error: 'unauthorized' })
})

test('messageCollector ignores a binary frame that arrives before the first JSON frame', async () => {
  // A binary Yjs doc-update frame can race in front of the app-level JSON
  // frame a caller is actually waiting for. It must be skipped, not treated
  // as (and fail to parse as) the "first" message.
  const { ws, emitMessage } = fakeSocket()
  const nextMessage = messageCollector(ws)

  emitMessage('not valid json, this is a stand-in for binary doc bytes', true)
  emitMessage(JSON.stringify({ error: 'unauthorized' }))

  assert.deepEqual(await nextMessage(500), { error: 'unauthorized' })
})

test('messageCollector ignores an unparsable text frame and waits for a later JSON frame', async () => {
  const { ws, emitMessage } = fakeSocket()
  const nextMessage = messageCollector(ws)

  emitMessage('not json')
  emitMessage(JSON.stringify({ error: 'unauthorized' }))

  assert.deepEqual(await nextMessage(500), { error: 'unauthorized' })
})

test('messageCollector resolves null when only a binary frame arrives before the timeout', async () => {
  const { ws, emitMessage } = fakeSocket()
  const nextMessage = messageCollector(ws)

  emitMessage('binary doc bytes', true)

  assert.equal(await nextMessage(50), null)
})
