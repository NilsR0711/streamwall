import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'

import {
  SENTRY_DSN_ENV,
  SENTRY_ENABLED_ENV,
  captureException,
  getSentryConfig,
  initSentry,
} from './sentry.ts'
import { recordingLogger } from './testHelpers.ts'

describe('getSentryConfig', () => {
  const originalEnabled = process.env[SENTRY_ENABLED_ENV]
  const originalDsn = process.env[SENTRY_DSN_ENV]

  afterEach(() => {
    if (originalEnabled === undefined) {
      delete process.env[SENTRY_ENABLED_ENV]
    } else {
      process.env[SENTRY_ENABLED_ENV] = originalEnabled
    }
    if (originalDsn === undefined) {
      delete process.env[SENTRY_DSN_ENV]
    } else {
      process.env[SENTRY_DSN_ENV] = originalDsn
    }
  })

  test('defaults to disabled with no DSN when unset', () => {
    delete process.env[SENTRY_ENABLED_ENV]
    delete process.env[SENTRY_DSN_ENV]

    assert.deepEqual(getSentryConfig(), { enabled: false, dsn: undefined })
  })

  test('enables only on the exact string "true"', () => {
    process.env[SENTRY_ENABLED_ENV] = 'true'
    assert.equal(getSentryConfig().enabled, true)

    process.env[SENTRY_ENABLED_ENV] = '1'
    assert.equal(getSentryConfig().enabled, false)

    process.env[SENTRY_ENABLED_ENV] = 'TRUE'
    assert.equal(getSentryConfig().enabled, false)
  })

  test('reads the DSN from the environment', () => {
    process.env[SENTRY_DSN_ENV] = 'https://example@o0.ingest.sentry.io/1'
    assert.equal(getSentryConfig().dsn, 'https://example@o0.ingest.sentry.io/1')
  })
})

describe('initSentry', () => {
  function fakeClient() {
    const calls: Array<{ dsn: string }> = []
    return {
      calls,
      init(options: { dsn: string }) {
        calls.push(options)
      },
    }
  }

  let warnCalls: unknown[][]
  let originalWarn: typeof console.warn

  beforeEach(() => {
    warnCalls = []
    originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args)
    }
  })

  afterEach(() => {
    console.warn = originalWarn
  })

  test('does nothing when disabled', () => {
    const client = fakeClient()
    const logger = recordingLogger()

    const result = initSentry(
      logger.log,
      { enabled: false, dsn: undefined },
      client,
    )

    assert.equal(result, false)
    assert.equal(client.calls.length, 0)
    assert.equal(logger.entries.length, 0)
    assert.equal(warnCalls.length, 0)
  })

  test('initializes the client with the configured DSN when enabled', () => {
    const client = fakeClient()

    const result = initSentry(
      recordingLogger().log,
      { enabled: true, dsn: 'https://example@o0.ingest.sentry.io/1' },
      client,
    )

    assert.equal(result, true)
    assert.deepEqual(client.calls, [
      { dsn: 'https://example@o0.ingest.sentry.io/1' },
    ])
  })

  test('warns through the structured logger and skips initialization when enabled without a DSN', () => {
    const client = fakeClient()
    const logger = recordingLogger()

    const result = initSentry(
      logger.log,
      { enabled: true, dsn: undefined },
      client,
    )

    assert.equal(result, false)
    assert.equal(client.calls.length, 0)
    assert.equal(logger.entries.length, 1)
    const [entry] = logger.entries
    assert.equal(entry.level, 'warn')
    assert.deepEqual(entry.fields, {
      enabledEnv: SENTRY_ENABLED_ENV,
      dsnEnv: SENTRY_DSN_ENV,
    })
    assert.match(String(entry.msg), new RegExp(SENTRY_DSN_ENV))
    assert.equal(
      warnCalls.length,
      0,
      'the warning must not bypass the structured logger (issue #493)',
    )
  })
})

describe('captureException', () => {
  function fakeCaptureClient() {
    const calls: unknown[] = []
    return {
      calls,
      captureException(err: unknown) {
        calls.push(err)
        return 'fake-event-id'
      },
    }
  }

  test('does nothing when crash reporting is disabled', () => {
    const client = fakeCaptureClient()
    const err = new Error('boom')

    captureException(err, false, client)

    assert.equal(client.calls.length, 0)
  })

  test('forwards the error to the client when crash reporting is enabled', () => {
    const client = fakeCaptureClient()
    const err = new Error('boom')

    captureException(err, true, client)

    assert.deepEqual(client.calls, [err])
  })
})
