import { describe, expect, test } from 'vitest'
import { blurHotkeyLayerBindings, getHotkeyLabel } from './hotkeyLabel.ts'

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

describe('blurHotkeyLayerBindings', () => {
  test('layer 0 chords the base 20 trigger keys with alt+shift', () => {
    expect(blurHotkeyLayerBindings[0]).toBe(
      'alt+shift+1,alt+shift+2,alt+shift+3,alt+shift+4,alt+shift+5,alt+shift+6,alt+shift+7,alt+shift+8,alt+shift+9,alt+shift+0,alt+shift+q,alt+shift+w,alt+shift+e,alt+shift+r,alt+shift+t,alt+shift+y,alt+shift+u,alt+shift+i,alt+shift+o,alt+shift+p',
    )
  })

  test('layer 1 chords the same 20 trigger keys with alt+ctrl+shift, avoiding the audio layer 1 (alt+ctrl) collision', () => {
    expect(blurHotkeyLayerBindings[1]).toBe(
      'alt+ctrl+shift+1,alt+ctrl+shift+2,alt+ctrl+shift+3,alt+ctrl+shift+4,alt+ctrl+shift+5,alt+ctrl+shift+6,alt+ctrl+shift+7,alt+ctrl+shift+8,alt+ctrl+shift+9,alt+ctrl+shift+0,alt+ctrl+shift+q,alt+ctrl+shift+w,alt+ctrl+shift+e,alt+ctrl+shift+r,alt+ctrl+shift+t,alt+ctrl+shift+y,alt+ctrl+shift+u,alt+ctrl+shift+i,alt+ctrl+shift+o,alt+ctrl+shift+p',
    )
  })

  test('only defines two layers, matching the 40-cell reach of the audio hotkeys', () => {
    expect(blurHotkeyLayerBindings).toHaveLength(2)
  })
})
