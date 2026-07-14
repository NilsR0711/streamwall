import { describe, expect, test } from 'vitest'
import { parseDisconnectReason } from './connectionStatus.ts'

describe('parseDisconnectReason', () => {
  test('recognizes an unauthorized session', () => {
    expect(parseDisconnectReason({ error: 'unauthorized' })).toBe(
      'unauthorized',
    )
  })

  test('recognizes the Streamwall app being disconnected', () => {
    expect(parseDisconnectReason({ error: 'streamwall disconnected' })).toBe(
      'streamwall-disconnected',
    )
  })

  test('recognizes an inbound message rate limit', () => {
    expect(parseDisconnectReason({ error: 'rate limit exceeded' })).toBe(
      'rate-limited',
    )
  })

  test('returns null for an unrelated server error', () => {
    expect(
      parseDisconnectReason({ error: 'streamwall already connected' }),
    ).toBeNull()
  })

  test('returns null for a state push', () => {
    expect(parseDisconnectReason({ type: 'state', state: {} })).toBeNull()
  })

  test('returns null for a state delta', () => {
    expect(parseDisconnectReason({ type: 'state-delta', delta: {} })).toBeNull()
  })

  test('returns null for a command response', () => {
    expect(
      parseDisconnectReason({ response: true, id: 1, tokenId: 'abc' }),
    ).toBeNull()
  })

  test.each([null, undefined, 'unauthorized', 42, ['unauthorized'], true])(
    'returns null for non-object input %p',
    (input) => {
      expect(parseDisconnectReason(input)).toBeNull()
    },
  )

  test('returns null when the error field is not a string', () => {
    expect(parseDisconnectReason({ error: 42 })).toBeNull()
  })
})
