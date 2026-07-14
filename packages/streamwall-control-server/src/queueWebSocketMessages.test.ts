import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import type WebSocket from 'ws'

import { queueWebSocketMessages } from './index.ts'

/**
 * A minimal stand-in for a `ws` socket: `queueWebSocketMessages` only ever
 * calls `.on('message', ...)` and `.on('close', ...)`, both of which a plain
 * `EventEmitter` satisfies.
 */
function fakeSocket() {
  const emitter = new EventEmitter()
  return {
    ws: emitter as unknown as WebSocket,
    emitMessage: (data: WebSocket.Data) => emitter.emit('message', data),
    emitClose: () => emitter.emit('close'),
  }
}

test('queues messages that arrive before a handler is attached, then delivers them once, in order', () => {
  const { ws, emitMessage } = fakeSocket()
  const setHandler = queueWebSocketMessages(ws)

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
  const setHandler = queueWebSocketMessages(ws)

  const received: WebSocket.Data[] = []
  setHandler((data) => received.push(data))

  emitMessage('third')

  assert.deepEqual(received, ['third'])
})

test('does not replay a message more than once across mixed queued and live delivery', () => {
  const { ws, emitMessage } = fakeSocket()
  const setHandler = queueWebSocketMessages(ws)

  emitMessage('queued')
  const received: WebSocket.Data[] = []
  setHandler((data) => received.push(data))
  emitMessage('live')

  assert.deepEqual(received, ['queued', 'live'])
})

test('clears any pending queue on close so a later handler never replays stale messages', () => {
  const { ws, emitMessage, emitClose } = fakeSocket()
  const setHandler = queueWebSocketMessages(ws)

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
