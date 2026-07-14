import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'

import {
  SENTRY_DSN_ENV,
  SENTRY_ENABLED_ENV,
  getSentryConfig,
  initSentry,
} from './sentry.ts'

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

    const result = initSentry({ enabled: false, dsn: undefined }, client)

    assert.equal(result, false)
    assert.equal(client.calls.length, 0)
    assert.equal(warnCalls.length, 0)
  })

  test('initializes the client with the configured DSN when enabled', () => {
    const client = fakeClient()

    const result = initSentry(
      { enabled: true, dsn: 'https://example@o0.ingest.sentry.io/1' },
      client,
    )

    assert.equal(result, true)
    assert.deepEqual(client.calls, [
      { dsn: 'https://example@o0.ingest.sentry.io/1' },
    ])
  })

  test('warns and skips initialization when enabled without a DSN', () => {
    const client = fakeClient()

    const result = initSentry({ enabled: true, dsn: undefined }, client)

    assert.equal(result, false)
    assert.equal(client.calls.length, 0)
    assert.equal(warnCalls.length, 1)
    assert.match(String(warnCalls[0][0]), new RegExp(SENTRY_DSN_ENV))
  })
})
