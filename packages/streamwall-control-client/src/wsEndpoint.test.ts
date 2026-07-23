import { describe, expect, it } from 'vitest'
import { getWebsocketEndpoint } from './wsEndpoint.ts'

const httpPage = { protocol: 'http:', host: 'localhost:3000' }
const httpsPage = { protocol: 'https:', host: 'control.example.com' }

describe('getWebsocketEndpoint', () => {
  it('uses ws:// for the default base on an http page (local dev)', () => {
    expect(getWebsocketEndpoint('/', httpPage)).toBe(
      'ws://localhost:3000/client/ws',
    )
  })

  it('uses wss:// for the default base on an https page (regression #617)', () => {
    // The published Docker image always builds the client with BASE_URL '/';
    // behind TLS the socket must be wss:// or the browser blocks it.
    expect(getWebsocketEndpoint('/', httpsPage)).toBe(
      'wss://control.example.com/client/ws',
    )
  })

  it('keeps the page host and port on an https page with a port', () => {
    expect(
      getWebsocketEndpoint('/', {
        protocol: 'https:',
        host: 'example.com:8443',
      }),
    ).toBe('wss://example.com:8443/client/ws')
  })

  it('maps an absolute https:// base to wss://', () => {
    expect(getWebsocketEndpoint('https://control.example.com', httpPage)).toBe(
      'wss://control.example.com/client/ws',
    )
  })

  it('maps an absolute http:// base to ws://', () => {
    expect(getWebsocketEndpoint('http://localhost:3000', httpsPage)).toBe(
      'ws://localhost:3000/client/ws',
    )
  })

  it('passes ws:// and wss:// bases through unchanged', () => {
    expect(getWebsocketEndpoint('ws://localhost:3000', httpsPage)).toBe(
      'ws://localhost:3000/client/ws',
    )
    expect(getWebsocketEndpoint('wss://control.example.com', httpPage)).toBe(
      'wss://control.example.com/client/ws',
    )
  })

  it('resolves a path base against the page and keeps the path', () => {
    expect(getWebsocketEndpoint('/control/', httpsPage)).toBe(
      'wss://control.example.com/control/client/ws',
    )
    expect(getWebsocketEndpoint('/control', httpPage)).toBe(
      'ws://localhost:3000/control/client/ws',
    )
  })

  it('does not double the slash for an absolute base with a trailing slash', () => {
    expect(getWebsocketEndpoint('https://control.example.com/', httpPage)).toBe(
      'wss://control.example.com/client/ws',
    )
  })
})
