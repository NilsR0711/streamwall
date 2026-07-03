import assert from 'node:assert/strict'
import test from 'node:test'
import { LAYER_FRAME_SANDBOX } from './layerFrameSandbox.ts'

const tokens = LAYER_FRAME_SANDBOX.split(' ').filter(Boolean)

test('LAYER_FRAME_SANDBOX allows scripts so overlay/background widgets can render', () => {
  assert.ok(tokens.includes('allow-scripts'), 'allow-scripts must be granted')
})

test('LAYER_FRAME_SANDBOX never grants allow-same-origin, which would defeat the sandbox', () => {
  assert.ok(
    !tokens.includes('allow-same-origin'),
    'allow-same-origin must not be granted',
  )
  assert.doesNotMatch(LAYER_FRAME_SANDBOX, /allow-same-origin/)
})

test('LAYER_FRAME_SANDBOX grants no navigation, popup, form or download escape hatches', () => {
  const escapes = [
    'allow-top-navigation',
    'allow-top-navigation-by-user-activation',
    'allow-top-navigation-to-custom-protocols',
    'allow-popups',
    'allow-popups-to-escape-sandbox',
    'allow-forms',
    'allow-modals',
    'allow-downloads',
    'allow-pointer-lock',
  ]
  for (const escape of escapes) {
    assert.ok(!tokens.includes(escape), `${escape} must not be granted`)
  }
})

test('LAYER_FRAME_SANDBOX is a normalized, space-separated token list', () => {
  assert.equal(LAYER_FRAME_SANDBOX, tokens.join(' '))
  assert.equal(LAYER_FRAME_SANDBOX, LAYER_FRAME_SANDBOX.trim())
})
