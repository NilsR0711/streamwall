import { describe, expect, it } from 'vitest'
import { shouldHideInsteadOfQuit } from './windowCloseBehavior'

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
