import { describe, expect, it } from 'vitest'
import { decideControlEndpointConnection } from './controlEndpointConnection'

describe('decideControlEndpointConnection', () => {
  it('skips when no control endpoint is configured', () => {
    expect(decideControlEndpointConnection(null)).toEqual({
      action: 'skip',
      reason: 'none',
    })
    expect(decideControlEndpointConnection(undefined)).toEqual({
      action: 'skip',
      reason: 'none',
    })
    expect(decideControlEndpointConnection('')).toEqual({
      action: 'skip',
      reason: 'none',
    })
  })

  it('refuses an insecure remote endpoint', () => {
    expect(
      decideControlEndpointConnection('ws://example.com/streamwall/ws?token=x'),
    ).toEqual({
      action: 'skip',
      reason: 'insecure',
      endpoint: 'ws://example.com/streamwall/ws?token=x',
    })
  })

  it('allows a secure wss endpoint', () => {
    expect(
      decideControlEndpointConnection(
        'wss://control.example.com/streamwall/abc/ws?token=xyz',
      ),
    ).toEqual({
      action: 'connect',
      endpoint: 'wss://control.example.com/streamwall/abc/ws?token=xyz',
    })
  })

  it('allows a loopback ws endpoint for local development', () => {
    expect(decideControlEndpointConnection('ws://localhost:8080/ws')).toEqual({
      action: 'connect',
      endpoint: 'ws://localhost:8080/ws',
    })
  })
})
