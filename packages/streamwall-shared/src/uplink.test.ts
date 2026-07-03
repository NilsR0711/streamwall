import { describe, expect, test } from 'vitest'
import { isCommandAllowedFromUplink } from './uplink.ts'

describe('isCommandAllowedFromUplink', () => {
  test('allows view and stream control commands', () => {
    expect(isCommandAllowedFromUplink('set-listening-view')).toBe(true)
    expect(isCommandAllowedFromUplink('set-view-background-listening')).toBe(
      true,
    )
    expect(isCommandAllowedFromUplink('set-view-blurred')).toBe(true)
    expect(isCommandAllowedFromUplink('rotate-stream')).toBe(true)
    expect(isCommandAllowedFromUplink('update-custom-stream')).toBe(true)
    expect(isCommandAllowedFromUplink('delete-custom-stream')).toBe(true)
    expect(isCommandAllowedFromUplink('reload-view')).toBe(true)
    expect(isCommandAllowedFromUplink('set-stream-censored')).toBe(true)
    expect(isCommandAllowedFromUplink('set-stream-running')).toBe(true)
    expect(isCommandAllowedFromUplink('set-grid-size')).toBe(true)
  })

  test('rejects code-execution commands from the uplink', () => {
    expect(isCommandAllowedFromUplink('browse')).toBe(false)
    expect(isCommandAllowedFromUplink('dev-tools')).toBe(false)
  })

  test('rejects auth-management commands from the uplink', () => {
    expect(isCommandAllowedFromUplink('create-invite')).toBe(false)
    expect(isCommandAllowedFromUplink('delete-token')).toBe(false)
  })

  test('rejects unknown, empty, or malformed command types', () => {
    expect(isCommandAllowedFromUplink('')).toBe(false)
    expect(isCommandAllowedFromUplink('constructor')).toBe(false)
    expect(isCommandAllowedFromUplink('__proto__')).toBe(false)
    expect(isCommandAllowedFromUplink('evil-command')).toBe(false)
    // @ts-expect-error verify runtime safety against non-string input
    expect(isCommandAllowedFromUplink(undefined)).toBe(false)
    // @ts-expect-error verify runtime safety against non-string input
    expect(isCommandAllowedFromUplink(null)).toBe(false)
  })
})
