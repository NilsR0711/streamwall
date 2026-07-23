import WebSocket from 'ws'

import type { HeartbeatConfig, WsMessageLimitConfig } from './config.ts'
import type { Logger } from './logger.ts'
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

// Bounds on the pre-handler message queue below. The queue only exists for
// the short window before a route finishes its async connection validation
// (e.g. the awaited scrypt token check) and attaches a message handler, so
// legitimate traffic in that window is tiny. A peer exceeding either bound is
// flooding before auth completed and gets disconnected (issue #623).
export const WS_QUEUE_MAX_MESSAGES = 256
export const WS_QUEUE_MAX_BYTES = 1024 * 1024

/** Byte size of an inbound `ws` message payload, across its possible shapes. */
function dataByteLength(data: WebSocket.Data): number {
  if (typeof data === 'string') {
    return Buffer.byteLength(data)
  }
  if (Array.isArray(data)) {
    let total = 0
    for (const chunk of data) {
      total += chunk.byteLength
    }
    return total
  }
  return data.byteLength
}

/**
 * Helper to immediately watch for and queue incoming websocket messages.
 * This is useful for async validation of the connection before handling messages,
 * because awaiting before adding a message event listener can drop messages.
 *
 * The queue is bounded ({@link WS_QUEUE_MAX_MESSAGES} messages /
 * {@link WS_QUEUE_MAX_BYTES} bytes): a peer that floods frames before the
 * handler is attached — i.e. before auth has completed — is closed with 1008
 * and its queued frames are dropped, so an unauthenticated peer cannot buffer
 * unbounded memory during the validation window.
 */
export function queueWebSocketMessages(ws: WebSocket, log: Logger) {
  let queue: WebSocket.Data[] = []
  let queuedBytes = 0
  let overflowed = false
  let messageHandler: ((rawData: WebSocket.Data) => void) | null = null

  const processQueue = () => {
    if (messageHandler !== null) {
      let queuedData
      while ((queuedData = queue.shift())) {
        messageHandler(queuedData)
      }
      queuedBytes = 0
    }
  }

  const setMessageHandler = (handler: typeof messageHandler) => {
    messageHandler = handler
    processQueue()
  }

  ws.on('message', (rawData) => {
    if (overflowed) {
      return
    }
    if (messageHandler === null) {
      const nextBytes = queuedBytes + dataByteLength(rawData)
      if (
        queue.length >= WS_QUEUE_MAX_MESSAGES ||
        nextBytes > WS_QUEUE_MAX_BYTES
      ) {
        overflowed = true
        log.warn(
          { queuedMessages: queue.length, queuedBytes },
          'WebSocket message queue overflowed before validation completed, closing connection',
        )
        queue = []
        queuedBytes = 0
        ws.close(1008, 'message queue overflow')
        return
      }
      queuedBytes = nextBytes
    }
    queue.push(rawData)
    processQueue()
  })

  ws.on('close', () => {
    queue = []
    queuedBytes = 0
    messageHandler = null
  })

  return setMessageHandler
}

/**
 * Starts a ping/pong liveness probe on a socket: a peer that vanishes without
 * a TCP FIN (laptop sleep, NAT idle timeout, network partition) never fires
 * 'close' on its own, so a missed pong terminates the socket, which fires
 * 'close' and lets the route's cleanup run (issues #618/#635).
 *
 * `label` names the peer in the timeout warning (e.g. `Client`, `Streamwall`).
 * Returns a stop function that clears every timer and listener the heartbeat
 * registered; call it from the route's 'close' handler.
 */
export function startHeartbeat(
  ws: WebSocket,
  { intervalMs, timeoutMs }: HeartbeatConfig,
  label: string,
  log: Logger,
): () => void {
  let pongTimeout: NodeJS.Timeout | undefined
  const onPong = () => {
    clearTimeout(pongTimeout)
  }
  const pingInterval = setInterval(() => {
    ws.ping()
    clearTimeout(pongTimeout)
    pongTimeout = setTimeout(() => {
      if (ws.readyState === ws.OPEN) {
        log.warn(
          `${label} timeout: no pong within ${timeoutMs}ms. Closing connection.`,
        )
        ws.terminate()
      }
    }, timeoutMs)
  }, intervalMs)
  ws.on('pong', onPong)
  return () => {
    clearInterval(pingInterval)
    clearTimeout(pongTimeout)
    ws.off('pong', onPong)
  }
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
  log: Logger,
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
    log.warn(`WebSocket message rate limit exceeded, closing ${label}`)
    try {
      ws.send(JSON.stringify({ error: 'rate limit exceeded' }))
    } catch {
      // The socket is being closed anyway; ignore send failures.
    }
    ws.close(1008, 'rate limit exceeded')
    return false
  }
}
