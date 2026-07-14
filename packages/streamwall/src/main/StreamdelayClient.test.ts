import { describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import StreamdelayClient from './StreamdelayClient'

describe('StreamdelayClient emitState', () => {
  it('reports disconnected even when the cached status still says connected', () => {
    const client = new StreamdelayClient({ endpoint: 'http://x', key: 'k' })
    // Simulate a status message received while connected, which itself
    // carries a stale `isConnected: true` (the server echoes it back).
    client.status = {
      isConnected: true,
      delaySeconds: 0,
      restartSeconds: 0,
      isCensored: false,
      isStreamRunning: false,
      startTime: 0,
      state: 'running',
    }
    // The socket has since closed.
    client.ws = { readyState: WebSocket.CLOSED } as unknown as typeof client.ws

    const listener = vi.fn()
    client.on('state', listener)
    client.emitState()

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ isConnected: false }),
    )
  })

  it('reports connected when the socket is open', () => {
    const client = new StreamdelayClient({ endpoint: 'http://x', key: 'k' })
    client.status = {
      isConnected: false,
      delaySeconds: 0,
      restartSeconds: 0,
      isCensored: false,
      isStreamRunning: false,
      startTime: 0,
      state: 'running',
    }
    client.ws = { readyState: WebSocket.OPEN } as unknown as typeof client.ws

    const listener = vi.fn()
    client.on('state', listener)
    client.emitState()

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ isConnected: true }),
    )
  })
})
