import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULT_SCRYPT_PARAMS } from './auth.ts'
import { captureLogs, TEST_SCRYPT_PARAMS } from './testHelpers.ts'

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
