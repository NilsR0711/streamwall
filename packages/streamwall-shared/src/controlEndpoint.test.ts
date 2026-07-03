import { describe, expect, test } from 'vitest'
import { isSecureControlEndpoint } from './controlEndpoint.ts'

describe('isSecureControlEndpoint', () => {
  test('accepts wss:// endpoints to any host', () => {
    expect(
      isSecureControlEndpoint('wss://example.com/streamwall/abc/ws?token=xyz'),
    ).toBe(true)
    expect(isSecureControlEndpoint('wss://control.example.org:8443/ws')).toBe(
      true,
    )
  })

  test('rejects plaintext ws:// to a remote host', () => {
    expect(
      isSecureControlEndpoint('ws://example.com/streamwall/abc/ws?token=xyz'),
    ).toBe(false)
    expect(isSecureControlEndpoint('ws://192.168.1.10:8080/ws')).toBe(false)
  })

  test('accepts plaintext ws:// to loopback hosts', () => {
    expect(isSecureControlEndpoint('ws://localhost:8080/ws')).toBe(true)
    expect(isSecureControlEndpoint('ws://127.0.0.1:8080/ws')).toBe(true)
    expect(isSecureControlEndpoint('ws://[::1]:8080/ws')).toBe(true)
  })

  test('rejects non-websocket protocols even over TLS', () => {
    expect(isSecureControlEndpoint('https://example.com/ws')).toBe(false)
    expect(isSecureControlEndpoint('http://example.com/ws')).toBe(false)
  })

  test('rejects malformed or empty endpoints', () => {
    expect(isSecureControlEndpoint('')).toBe(false)
    expect(isSecureControlEndpoint('not a url')).toBe(false)
    expect(isSecureControlEndpoint('wss://')).toBe(false)
  })
})
