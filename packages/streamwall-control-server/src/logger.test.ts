import assert from 'node:assert/strict'
import process from 'node:process'
import { after, test } from 'node:test'

import {
  getLoggerOptions,
  redactRequestUrl,
  resolveLogLevel,
  tokenIdPrefix,
} from './logger.ts'

after(() => {
  delete process.env.LOG_LEVEL
})

test('resolveLogLevel defaults to info when unset or blank', () => {
  assert.equal(resolveLogLevel(undefined), 'info')
  assert.equal(resolveLogLevel(''), 'info')
  assert.equal(resolveLogLevel('   '), 'info')
})

test('resolveLogLevel accepts every pino level, case-insensitively', () => {
  for (const level of [
    'fatal',
    'error',
    'warn',
    'info',
    'debug',
    'trace',
    'silent',
  ]) {
    assert.equal(resolveLogLevel(level), level)
    assert.equal(resolveLogLevel(level.toUpperCase()), level)
  }
})

test('resolveLogLevel falls back to info for an unknown level', () => {
  // A typo must never silence the server or crash it at boot.
  assert.equal(resolveLogLevel('verbose'), 'info')
})

test('getLoggerOptions reads LOG_LEVEL from the environment', () => {
  process.env.LOG_LEVEL = 'debug'
  assert.equal(getLoggerOptions().level, 'debug')
  delete process.env.LOG_LEVEL
  assert.equal(getLoggerOptions().level, 'info')
})

test('tokenIdPrefix keeps only a short, non-identifying prefix', () => {
  const prefix = tokenIdPrefix('abcdefgh')
  assert.equal(prefix, 'abcd')
  assert.ok(!('abcdefgh'.startsWith(prefix) && prefix.length >= 8))
})

test('redactRequestUrl strips token ids out of logged paths', () => {
  assert.equal(
    redactRequestUrl('/streamwall/s3cr3tId/ws'),
    '/streamwall/[redacted]/ws',
  )
  assert.equal(redactRequestUrl('/invite/s3cr3tId'), '/invite/[redacted]')
  assert.equal(
    redactRequestUrl('/invite/s3cr3tId?next=/'),
    '/invite/[redacted]?next=/',
  )
})

test('redactRequestUrl leaves unrelated paths untouched', () => {
  assert.equal(redactRequestUrl('/admin/status'), '/admin/status')
  assert.equal(redactRequestUrl('/client/ws'), '/client/ws')
  assert.equal(redactRequestUrl('/'), '/')
})
