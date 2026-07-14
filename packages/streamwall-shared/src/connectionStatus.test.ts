import { describe, expect, test } from 'vitest'
import { nextConnectionStatus } from './connectionStatus.ts'

describe('nextConnectionStatus', () => {
  test('a received state always resolves to connected', () => {
    for (const current of [
      'connecting',
      'connected',
      'reconnecting',
      'unauthorized',
      'server-down',
    ] as const) {
      expect(nextConnectionStatus(current, { type: 'state-received' })).toBe(
        'connected',
      )
    }
  })

  test('an unauthorized error overrides any prior status', () => {
    for (const current of [
      'connecting',
      'connected',
      'reconnecting',
      'server-down',
    ] as const) {
      expect(nextConnectionStatus(current, { type: 'unauthorized' })).toBe(
        'unauthorized',
      )
    }
  })

  test('a server-down error overrides any prior status', () => {
    for (const current of [
      'connecting',
      'connected',
      'reconnecting',
      'unauthorized',
    ] as const) {
      expect(nextConnectionStatus(current, { type: 'server-down' })).toBe(
        'server-down',
      )
    }
  })

  test('closing a live connection starts reconnecting', () => {
    expect(nextConnectionStatus('connected', { type: 'closed' })).toBe(
      'reconnecting',
    )
  })

  test('closing while already reconnecting stays reconnecting', () => {
    expect(nextConnectionStatus('reconnecting', { type: 'closed' })).toBe(
      'reconnecting',
    )
  })

  test('closing before any state was ever received stays connecting', () => {
    expect(nextConnectionStatus('connecting', { type: 'closed' })).toBe(
      'connecting',
    )
  })

  test('closing after unauthorized preserves the unauthorized reason', () => {
    expect(nextConnectionStatus('unauthorized', { type: 'closed' })).toBe(
      'unauthorized',
    )
  })

  test('closing after server-down preserves the server-down reason', () => {
    expect(nextConnectionStatus('server-down', { type: 'closed' })).toBe(
      'server-down',
    )
  })
})
