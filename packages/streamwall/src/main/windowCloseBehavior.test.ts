import { describe, expect, it } from 'vitest'
import {
  shouldHideInsteadOfQuit,
  shouldQuitOnAllWindowsClosed,
} from './windowCloseBehavior'

describe('shouldHideInsteadOfQuit', () => {
  it('hides the window on macOS when the app is not quitting', () => {
    expect(shouldHideInsteadOfQuit('darwin', false)).toBe(true)
  })

  it('lets the window close on macOS once the app is quitting', () => {
    expect(shouldHideInsteadOfQuit('darwin', true)).toBe(false)
  })

  it('lets the window close on Windows regardless of quitting state', () => {
    expect(shouldHideInsteadOfQuit('win32', false)).toBe(false)
    expect(shouldHideInsteadOfQuit('win32', true)).toBe(false)
  })

  it('lets the window close on Linux regardless of quitting state', () => {
    expect(shouldHideInsteadOfQuit('linux', false)).toBe(false)
    expect(shouldHideInsteadOfQuit('linux', true)).toBe(false)
  })
})

describe('shouldQuitOnAllWindowsClosed', () => {
  it('does not quit on macOS once every window has closed', () => {
    expect(shouldQuitOnAllWindowsClosed('darwin')).toBe(false)
  })

  it('quits on Windows once every window has closed', () => {
    expect(shouldQuitOnAllWindowsClosed('win32')).toBe(true)
  })

  it('quits on Linux once every window has closed', () => {
    expect(shouldQuitOnAllWindowsClosed('linux')).toBe(true)
  })
})
