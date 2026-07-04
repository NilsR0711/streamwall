import { describe, expect, test } from 'vitest'
import { parseControlEndpoint } from './controlEndpoint.ts'

describe('parseControlEndpoint', () => {
  test('moves a token query parameter into an Authorization header', () => {
    const result = parseControlEndpoint(
      'wss://example.com/streamwall/abc/ws?token=s3cr3t',
    )
    expect(result.authorization).toBe('Bearer s3cr3t')
    expect(result.url).toBe('wss://example.com/streamwall/abc/ws')
  })

  test('strips only the token, preserving any other query parameters', () => {
    const result = parseControlEndpoint(
      'wss://example.com/streamwall/abc/ws?token=s3cr3t&debug=1',
    )
    expect(result.authorization).toBe('Bearer s3cr3t')
    expect(result.url).toBe('wss://example.com/streamwall/abc/ws?debug=1')
  })

  test('never leaves the secret in the connection URL', () => {
    const result = parseControlEndpoint(
      'wss://example.com/streamwall/abc/ws?token=s3cr3t',
    )
    expect(result.url).not.toContain('s3cr3t')
    expect(result.url).not.toContain('token=')
  })

  test('returns no Authorization header when the endpoint has no token', () => {
    const result = parseControlEndpoint('wss://example.com/streamwall/abc/ws')
    expect(result.authorization).toBeNull()
    expect(result.url).toBe('wss://example.com/streamwall/abc/ws')
  })

  test('treats an empty token as absent', () => {
    const result = parseControlEndpoint(
      'wss://example.com/streamwall/abc/ws?token=',
    )
    expect(result.authorization).toBeNull()
  })

  test('passes a malformed endpoint through unchanged with no header', () => {
    const result = parseControlEndpoint('not a url')
    expect(result.authorization).toBeNull()
    expect(result.url).toBe('not a url')
  })
})
