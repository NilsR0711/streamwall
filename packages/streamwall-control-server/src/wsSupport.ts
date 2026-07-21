import WebSocket from 'ws'

import type { WsMessageLimitConfig } from './config.ts'
import { TokenBucket } from './rateLimiter.ts'

/**
 * Extracts a Bearer token from an `Authorization` header. Uplink credentials
 * travel in this header rather than the URL query string so the secret never
 * lands in server or proxy access logs. The scheme name is matched
 * case-insensitively per RFC 7235.
 */
export function bearerToken(authorization: string | undefined): string | null {
  if (!authorization) {
    return null
  }
  const match = /^Bearer[ ]+(.+)$/i.exec(authorization)
  return match ? match[1] : null
}

/**
 * Helper to immediately watch for and queue incoming websocket messages.
 * This is useful for async validation of the connection before handling messages,
 * because awaiting before adding a message event listener can drop messages.
 */
export function queueWebSocketMessages(ws: WebSocket) {
  let queue: WebSocket.Data[] = []
  let messageHandler: ((rawData: WebSocket.Data) => void) | null = null

  const processQueue = () => {
    if (messageHandler !== null) {
      let queuedData
      while ((queuedData = queue.shift())) {
        messageHandler(queuedData)
      }
    }
  }

  const setMessageHandler = (handler: typeof messageHandler) => {
    messageHandler = handler
    processQueue()
  }

  ws.on('message', (rawData) => {
    queue.push(rawData)
    processQueue()
  })

  ws.on('close', () => {
    queue = []
    messageHandler = null
  })

  return setMessageHandler
}

/**
 * Wraps a socket with a per-connection inbound message rate limiter. Returns a
 * guard to invoke for each received message: it returns true when the message
 * may be processed, or closes the socket (once) and returns false when the
 * connection has exceeded its message budget.
 */
export function createWsMessageGuard(
  ws: WebSocket,
  config: WsMessageLimitConfig,
  label: string,
): () => boolean {
  const bucket = new TokenBucket({
    capacity: config.capacity,
    refillPerSec: config.refillPerSec,
  })
  let closed = false
  return () => {
    if (closed) {
      return false
    }
    if (bucket.tryConsume()) {
      return true
    }
    closed = true
    console.warn(`WebSocket message rate limit exceeded, closing ${label}`)
    try {
      ws.send(JSON.stringify({ error: 'rate limit exceeded' }))
    } catch {
      // The socket is being closed anyway; ignore send failures.
    }
    ws.close(1008, 'rate limit exceeded')
    return false
  }
}
