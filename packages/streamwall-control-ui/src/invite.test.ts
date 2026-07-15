import { describe, expect, test } from 'vitest'
import { parseInviteResponse } from './invite.ts'

describe('parseInviteResponse', () => {
  test('accepts a well-formed invite response', () => {
    expect(
      parseInviteResponse({
        tokenId: 'tok-1',
        name: 'Alex',
        secret: 's3cret',
      }),
    ).toEqual({
      tokenId: 'tok-1',
      name: 'Alex',
      secret: 's3cret',
    })
  })

  test('strips unrelated fields alongside a valid invite', () => {
    expect(
      parseInviteResponse({
        response: true,
        id: 0,
        tokenId: 'tok-1',
        name: 'Alex',
        secret: 's3cret',
      }),
    ).toEqual({
      tokenId: 'tok-1',
      name: 'Alex',
      secret: 's3cret',
    })
  })

  test('rejects a response missing the secret', () => {
    expect(parseInviteResponse({ tokenId: 'tok-1', name: 'Alex' })).toBeNull()
  })

  test('rejects a response with a non-string tokenId', () => {
    expect(
      parseInviteResponse({ tokenId: 42, name: 'Alex', secret: 's3cret' }),
    ).toBeNull()
  })

  test('rejects an empty object', () => {
    expect(parseInviteResponse({})).toBeNull()
  })

  test('rejects non-object responses', () => {
    expect(parseInviteResponse(undefined)).toBeNull()
    expect(parseInviteResponse(null)).toBeNull()
    expect(parseInviteResponse('tok-1')).toBeNull()
    expect(parseInviteResponse(42)).toBeNull()
  })
})
