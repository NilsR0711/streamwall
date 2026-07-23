import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import type WebSocket from 'ws'

import {
  queueWebSocketMessages,
  WS_QUEUE_MAX_BYTES,
  WS_QUEUE_MAX_MESSAGES,
} from './index.ts'
import type { Logger } from './logger.ts'
import { recordingLogger } from './testHelpers.ts'

/**
 * A minimal stand-in for a `ws` socket: `queueWebSocketMessages` only ever
 * calls `.on('message', ...)`, `.on('close', ...)` (both satisfied by a plain
 * `EventEmitter`) and `.close(code, reason)` on queue overflow, which is
 * recorded for assertions.
 */
function fakeSocket() {
  const emitter = new EventEmitter()
  const closeCalls: { code?: number; reason?: string }[] = []
  Object.assign(emitter, {
    close: (code?: number, reason?: string) => {
      closeCalls.push({ code, reason })
    },
  })
  return {
    ws: emitter as unknown as WebSocket,
    closeCalls,
    emitMessage: (data: WebSocket.Data) => emitter.emit('message', data),
    emitClose: () => emitter.emit('close'),
  }
}

function testLogger() {
  const { entries, log } = recordingLogger()
  return { entries, log: log as unknown as Logger }
}

test('queues messages that arrive before a handler is attached, then delivers them once, in order', () => {
  const { ws, emitMessage } = fakeSocket()
  const setHandler = queueWebSocketMessages(ws, testLogger().log)

  emitMessage('first')
  emitMessage('second')

  const received: WebSocket.Data[] = []
  setHandler((data) => received.push(data))

  assert.deepEqual(
    received,
    ['first', 'second'],
    'messages queued while validation is pending must still be delivered, in arrival order',
  )
})

test('delivers messages immediately once a handler is already attached', () => {
  const { ws, emitMessage } = fakeSocket()
  const setHandler = queueWebSocketMessages(ws, testLogger().log)

  const received: WebSocket.Data[] = []
  setHandler((data) => received.push(data))

  emitMessage('third')

  assert.deepEqual(received, ['third'])
})

test('does not replay a message more than once across mixed queued and live delivery', () => {
  const { ws, emitMessage } = fakeSocket()
  const setHandler = queueWebSocketMessages(ws, testLogger().log)

  emitMessage('queued')
  const received: WebSocket.Data[] = []
  setHandler((data) => received.push(data))
  emitMessage('live')

  assert.deepEqual(received, ['queued', 'live'])
})

test('clears any pending queue on close so a later handler never replays stale messages', () => {
  const { ws, emitMessage, emitClose } = fakeSocket()
  const setHandler = queueWebSocketMessages(ws, testLogger().log)

  emitMessage('stale')
  emitClose()

  const received: WebSocket.Data[] = []
  setHandler((data) => received.push(data))

  assert.deepEqual(
    received,
    [],
    'a message queued before close must not be replayed after the socket is gone',
  )
})

test('closes the socket with 1008 when the queued message count exceeds the cap', () => {
  const { ws, closeCalls, emitMessage } = fakeSocket()
  const { entries, log } = testLogger()
  const setHandler = queueWebSocketMessages(ws, log)

  for (let i = 0; i < WS_QUEUE_MAX_MESSAGES; i++) {
    emitMessage(`m${i}`)
  }
  assert.deepEqual(closeCalls, [], 'traffic at the cap must not close')

  emitMessage('one too many')

  assert.deepEqual(closeCalls, [
    { code: 1008, reason: 'message queue overflow' },
  ])
  assert.equal(entries.length, 1)
  assert.equal(entries[0].level, 'warn')

  // The queued frames must be released, not delivered to a later handler.
  const received: WebSocket.Data[] = []
  setHandler((data) => received.push(data))
  assert.deepEqual(
    received,
    [],
    'frames queued by a flooding peer must be dropped on overflow',
  )
})

test('closes the socket with 1008 when the queued bytes exceed the cap', () => {
  const { ws, closeCalls, emitMessage } = fakeSocket()
  const setHandler = queueWebSocketMessages(ws, testLogger().log)

  const half = Buffer.alloc(Math.ceil(WS_QUEUE_MAX_BYTES / 2) + 1)
  emitMessage(half)
  assert.deepEqual(closeCalls, [], 'a single frame under the cap must queue')

  emitMessage(half)

  assert.deepEqual(closeCalls, [
    { code: 1008, reason: 'message queue overflow' },
  ])

  const received: WebSocket.Data[] = []
  setHandler((data) => received.push(data))
  assert.deepEqual(received, [])
})

test('drops any further messages after an overflow instead of re-queueing them', () => {
  const { ws, closeCalls, emitMessage } = fakeSocket()
  const setHandler = queueWebSocketMessages(ws, testLogger().log)

  for (let i = 0; i <= WS_QUEUE_MAX_MESSAGES; i++) {
    emitMessage(`m${i}`)
  }
  assert.equal(closeCalls.length, 1)

  // The peer keeps sending while the close handshake is in flight.
  emitMessage('late')

  const received: WebSocket.Data[] = []
  setHandler((data) => received.push(data))
  assert.deepEqual(received, [])
  assert.equal(closeCalls.length, 1, 'the socket is only closed once')
})

test('does not count bytes against the cap once a handler is attached', () => {
  const { ws, closeCalls, emitMessage } = fakeSocket()
  const setHandler = queueWebSocketMessages(ws, testLogger().log)

  const received: WebSocket.Data[] = []
  setHandler((data) => received.push(data))

  // Well past both caps in aggregate; each frame is delivered immediately, so
  // nothing accumulates and the connection must stay open.
  const chunk = Buffer.alloc(Math.ceil(WS_QUEUE_MAX_BYTES / 4))
  for (let i = 0; i < 8; i++) {
    emitMessage(chunk)
  }

  assert.equal(received.length, 8)
  assert.deepEqual(closeCalls, [])
})
