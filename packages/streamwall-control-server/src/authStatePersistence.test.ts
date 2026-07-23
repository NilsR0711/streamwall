import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'

import type { SentryCaptureClient } from './sentry.ts'
import { buildTestApp, captureLogs, failingWriteDb } from './testHelpers.ts'

/** Pino's numeric level for `error` entries. */
const ERROR = 50

/** Reads the message off pino's serialized `err` field of a log entry. */
function loggedErrorMessage(entry: Record<string, unknown>) {
  return (entry.err as { message?: string } | undefined)?.message
}

/** Records every error passed to `captureException`. */
function fakeSentryClient(): SentryCaptureClient & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    calls,
    captureException(err: unknown) {
      calls.push(err)
      return 'fake-event-id'
    },
  }
}

// The auth 'state' listener persists every auth change to storage as a
// fire-and-forget write. Its rejection used to be dropped entirely, so a
// failed persist (disk full, read-only volume) was invisible while the
// in-memory auth state silently diverged from storage.json (issue #619).
describe('auth state persistence failures', () => {
  test('a failed auth state write is logged as an error', async () => {
    const logs = captureLogs()
    const { app, auth } = await buildTestApp({
      db: failingWriteDb(new Error('read-only volume')),
      logs,
    })
    after(() => app.close())

    await auth.createToken({ kind: 'invite', role: 'admin', name: 'invite' })

    const entry = await logs.waitForMessage(
      'Failed to persist auth state to storage',
    )
    assert.equal(entry.level, ERROR)
    assert.equal(loggedErrorMessage(entry), 'read-only volume')
  })

  test('a failed auth state write is reported to Sentry when enabled', async () => {
    const logs = captureLogs()
    const sentryClient = fakeSentryClient()
    const { app, auth } = await buildTestApp({
      db: failingWriteDb(new Error('disk full')),
      logs,
      sentryEnabled: true,
      sentryClient,
    })
    after(() => app.close())

    await auth.createToken({ kind: 'invite', role: 'admin', name: 'invite' })

    await logs.waitForMessage('Failed to persist auth state to storage')
    assert.equal(sentryClient.calls.length, 1)
    assert.equal((sentryClient.calls[0] as Error).message, 'disk full')
  })
})
