import { describe, expect, test } from 'vitest'
import { getHotkeyLabel } from './hotkeyLabel.ts'

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

  test('labels the last slot of the first (alt) layer', () => {
    expect(getHotkeyLabel(19)).toBe('Alt+P')
  })

  test('labels the first slot of the second (alt+ctrl) layer', () => {
    expect(getHotkeyLabel(20)).toBe('Alt+Ctrl+1')
  })

  test('labels the last digit slot of the second layer', () => {
    expect(getHotkeyLabel(29)).toBe('Alt+Ctrl+0')
  })

  test('labels the first letter slot of the second layer', () => {
    expect(getHotkeyLabel(30)).toBe('Alt+Ctrl+Q')
  })

  test('labels the last slot of the second layer', () => {
    expect(getHotkeyLabel(39)).toBe('Alt+Ctrl+P')
  })

  test('returns undefined beyond the two 20-slot layers', () => {
    expect(getHotkeyLabel(40)).toBeUndefined()
  })

  test('returns undefined for a negative index', () => {
    expect(getHotkeyLabel(-1)).toBeUndefined()
  })
})
