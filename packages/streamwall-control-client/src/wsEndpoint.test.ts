import { describe, expect, it } from 'vitest'

import { controlWebSocketEndpoint } from './wsEndpoint.ts'

describe('controlWebSocketEndpoint', () => {
  it('derives ws:// from an http page when BASE_URL is "/"', () => {
    expect(
      controlWebSocketEndpoint('/', {
        protocol: 'http:',
        host: '127.0.0.1:3000',
      }),
    ).toBe('ws://127.0.0.1:3000/client/ws')
  })

  it('derives wss:// from an https page when BASE_URL is "/"', () => {
    // Browsers block ws:// connections from secure contexts, so a client
    // served over TLS (e.g. the published Docker image behind Caddy) must
    // connect via wss:// (issue #617).
    expect(
      controlWebSocketEndpoint('/', {
        protocol: 'https:',
        host: 'control.example.com',
      }),
    ).toBe('wss://control.example.com/client/ws')
  })

  it('maps an explicit http BASE_URL to ws:// on an http page', () => {
    expect(
      controlWebSocketEndpoint('http://control.example.com', {
        protocol: 'http:',
        host: 'control.example.com',
      }),
    ).toBe('ws://control.example.com/client/ws')
  })

  it('maps an explicit https BASE_URL to wss://', () => {
    expect(
      controlWebSocketEndpoint('https://control.example.com', {
        protocol: 'https:',
        host: 'control.example.com',
      }),
    ).toBe('wss://control.example.com/client/ws')
  })

  it('upgrades an explicit http BASE_URL to wss:// when the page is https', () => {
    // A secure page can never open an insecure socket, whatever the build-time
    // base claims, so the page protocol wins.
    expect(
      controlWebSocketEndpoint('http://control.example.com', {
        protocol: 'https:',
        host: 'control.example.com',
      }),
    ).toBe('wss://control.example.com/client/ws')
  })

  it('tolerates a trailing slash on an explicit BASE_URL', () => {
    // Vite normalizes absolute bases to end with a slash; the endpoint path
    // must not end up with a double slash.
    expect(
      controlWebSocketEndpoint('https://control.example.com/', {
        protocol: 'https:',
        host: 'control.example.com',
      }),
    ).toBe('wss://control.example.com/client/ws')
  })
})
