import assert from 'node:assert/strict'
import test from 'node:test'
import { isControlCommand } from './controlCommand.ts'

test('isControlCommand accepts a well-formed control command', () => {
  assert.equal(
    isControlCommand({ type: 'set-listening-view', viewIdx: 0 }),
    true,
  )
})

test('isControlCommand accepts any object with a string "type" (dispatch ignores unknown types)', () => {
  assert.equal(isControlCommand({ type: 'not-a-real-command' }), true)
})

// Regression test for issue #16: a failed JSON.parse yields undefined, which
// previously reached onCommand and threw on `msg.type`.
test('isControlCommand rejects undefined (the result of a failed JSON.parse)', () => {
  assert.equal(isControlCommand(undefined), false)
})

// Regression test for issue #16: `JSON.parse('null')` returns null, another
// value that previously threw on `msg.type`.
test('isControlCommand rejects null', () => {
  assert.equal(isControlCommand(null), false)
})

test('isControlCommand rejects primitive values', () => {
  assert.equal(isControlCommand('set-listening-view'), false)
  assert.equal(isControlCommand(42), false)
  assert.equal(isControlCommand(true), false)
})

test('isControlCommand rejects objects without a "type" property', () => {
  assert.equal(isControlCommand({}), false)
  assert.equal(isControlCommand({ viewIdx: 0 }), false)
})

test('isControlCommand rejects objects whose "type" is not a string', () => {
  assert.equal(isControlCommand({ type: 42 }), false)
  assert.equal(isControlCommand({ type: null }), false)
  assert.equal(isControlCommand({ type: undefined }), false)
})
