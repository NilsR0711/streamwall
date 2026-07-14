import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'

interface FakeSocketCall {
  url: string
  protocols: string[]
  options: Record<string, unknown>
}

const constructorCalls: FakeSocketCall[] = []

class FakeReconnectingWebSocket extends EventEmitter {
  static readonly OPEN = 1

  readyState = FakeReconnectingWebSocket.OPEN
  sent: unknown[] = []

  constructor(
    url: string,
    protocols: string[],
    options: Record<string, unknown>,
  ) {
    super()
    constructorCalls.push({ url, protocols, options })
  }

  addEventListener(event: string, listener: (...args: unknown[]) => void) {
    this.on(event, listener)
  }

  send(data: unknown) {
    this.sent.push(data)
  }
}

vi.mock('reconnecting-websocket', () => ({
  default: FakeReconnectingWebSocket,
}))

const { default: StreamdelayClient } = await import('./StreamdelayClient')

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

describe('StreamdelayClient reconnect queue', () => {
  it('bounds the ReconnectingWebSocket send queue instead of leaving it unbounded', () => {
    const client = new StreamdelayClient({
      endpoint: 'http://streamdelay.example',
      key: 'test-key',
    })

    client.connect()

    const { options } = constructorCalls.at(-1) as FakeSocketCall
    expect(options.maxEnqueuedMessages).toBeDefined()
    expect(options.maxEnqueuedMessages).not.toBe(Infinity)
    expect(options.maxEnqueuedMessages as number).toBeGreaterThanOrEqual(0)
  })

  it('still sends censor/running commands once connected', () => {
    const client = new StreamdelayClient({
      endpoint: 'http://streamdelay.example',
      key: 'test-key',
    })

    client.connect()
    const fakeWs = client.ws as unknown as FakeReconnectingWebSocket

    client.setCensored(true)
    client.setStreamRunning(false)

    expect(fakeWs.sent).toEqual([
      JSON.stringify({ isCensored: true }),
      JSON.stringify({ isStreamRunning: false }),
    ])
  })
})
