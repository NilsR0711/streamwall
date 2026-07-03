import { describe, expect, it } from 'vitest'
import { LAYER_FRAME_SANDBOX } from './layerFrameSandbox.ts'

const tokens = LAYER_FRAME_SANDBOX.split(' ').filter(Boolean)

describe('LAYER_FRAME_SANDBOX', () => {
  it('allows scripts so overlay/background widgets can render', () => {
    expect(tokens, 'allow-scripts must be granted').toContain('allow-scripts')
  })

  it('never grants allow-same-origin, which would defeat the sandbox', () => {
    expect(tokens, 'allow-same-origin must not be granted').not.toContain(
      'allow-same-origin',
    )
    expect(LAYER_FRAME_SANDBOX).not.toMatch(/allow-same-origin/)
  })

  it('grants no navigation, popup, form or download escape hatches', () => {
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
      expect(tokens, `${escape} must not be granted`).not.toContain(escape)
    }
  })

  it('is a normalized, space-separated token list', () => {
    expect(LAYER_FRAME_SANDBOX).toBe(tokens.join(' '))
    expect(LAYER_FRAME_SANDBOX).toBe(LAYER_FRAME_SANDBOX.trim())
  })
})
