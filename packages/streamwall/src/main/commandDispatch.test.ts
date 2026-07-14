import assert from 'node:assert/strict'
import { afterEach, beforeEach, test, vi } from 'vitest'

import { dispatchCommand } from './commandDispatch'
import log from './logger'

let unhandledRejections: unknown[] = []
const onUnhandledRejection = (reason: unknown) => {
  unhandledRejections.push(reason)
}

beforeEach(() => {
  unhandledRejections = []
  process.on('unhandledRejection', onUnhandledRejection)
})

afterEach(() => {
  process.off('unhandledRejection', onUnhandledRejection)
  vi.restoreAllMocks()
})

test('dispatchCommand invokes onCommand with the message and source', () => {
  const onCommand = vi.fn().mockResolvedValue(undefined)

  dispatchCommand(onCommand, { type: 'ping' }, 'local')

  assert.deepEqual(onCommand.mock.calls, [[{ type: 'ping' }, 'local']])
})

test('dispatchCommand logs and swallows a rejection instead of leaking an unhandled rejection', async () => {
  const err = new Error('downstream failure')
  const onCommand = vi.fn().mockRejectedValue(err)
  vi.spyOn(log, 'error').mockImplementation(() => undefined)

  dispatchCommand(onCommand, { type: 'ping' }, 'uplink')

  // Let the rejected promise's microtask queue (including any unhandled
  // rejection detection) settle before asserting.
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(unhandledRejections.length, 0)
  assert.equal(log.error.mock.calls.length, 1)
  const [message, loggedErr] = log.error.mock.calls[0]
  assert.match(message, /uplink/)
  assert.equal(loggedErr, err)
})

test('dispatchCommand tags the logged error with the local source', async () => {
  const err = new Error('boom')
  const onCommand = vi.fn().mockRejectedValue(err)
  vi.spyOn(log, 'error').mockImplementation(() => undefined)

  dispatchCommand(onCommand, { type: 'ping' }, 'local')
  await new Promise((resolve) => setImmediate(resolve))

  const [message] = log.error.mock.calls[0]
  assert.match(message, /local/)
})
