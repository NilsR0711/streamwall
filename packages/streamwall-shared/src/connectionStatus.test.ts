import { describe, expect, test } from 'vitest'
import { parseDisconnectReason, parseUplinkError } from './connectionStatus.ts'

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

describe('parseUplinkError', () => {
  test('recognizes a rejected uplink token', () => {
    expect(parseUplinkError({ error: 'unauthorized' })).toBe('unauthorized')
  })

  test('recognizes a conflicting Streamwall connection', () => {
    expect(parseUplinkError({ error: 'streamwall already connected' })).toBe(
      'already-connected',
    )
  })

  test('returns null for a client-only disconnect reason', () => {
    // 'streamwall disconnected' and 'rate limit exceeded' are only ever sent
    // on the browser client socket, never on the desktop uplink.
    expect(parseUplinkError({ error: 'streamwall disconnected' })).toBeNull()
    expect(parseUplinkError({ error: 'rate limit exceeded' })).toBeNull()
  })

  test('returns null for a state push', () => {
    expect(parseUplinkError({ type: 'state', state: {} })).toBeNull()
  })

  test('returns null for a command message', () => {
    expect(
      parseUplinkError({ type: 'set-view-blurred', viewIdx: 0, blurred: true }),
    ).toBeNull()
  })

  test.each([null, undefined, 'unauthorized', 42, ['unauthorized'], true])(
    'returns null for non-object input %p',
    (input) => {
      expect(parseUplinkError(input)).toBeNull()
    },
  )

  test('returns null when the error field is not a string', () => {
    expect(parseUplinkError({ error: 42 })).toBeNull()
  })
})
