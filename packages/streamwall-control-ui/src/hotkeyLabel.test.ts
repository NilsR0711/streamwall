import { describe, expect, test } from 'vitest'
import { getHotkeyLabel } from './index.tsx'

describe('getHotkeyLabel', () => {
  test('labels the first hotkey slot', () => {
    expect(getHotkeyLabel(0)).toBe('Alt+1')
  })

  test('labels the last digit slot', () => {
    expect(getHotkeyLabel(9)).toBe('Alt+0')
  })

  test('labels the first letter slot', () => {
    expect(getHotkeyLabel(10)).toBe('Alt+Q')
  })

  test('labels the last of the fixed 20 slots', () => {
    expect(getHotkeyLabel(19)).toBe('Alt+P')
  })

  test('returns undefined beyond the fixed 20-slot range', () => {
    expect(getHotkeyLabel(20)).toBeUndefined()
  })

  test('returns undefined for a negative index', () => {
    expect(getHotkeyLabel(-1)).toBeUndefined()
  })
})
