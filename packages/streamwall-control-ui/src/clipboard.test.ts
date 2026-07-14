import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyTextToClipboard } from './clipboard.ts'

describe('copyTextToClipboard', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes the given text to the clipboard', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })

    copyTextToClipboard('abc')

    expect(writeText).toHaveBeenCalledWith('abc')
  })

  it('logs a warning instead of throwing when the write is rejected asynchronously', async () => {
    const rejection = new Error('permission denied')
    const writeText = vi.fn().mockRejectedValue(rejection)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() => copyTextToClipboard('abc')).not.toThrow()
    // Flush the microtask queue so the promise rejection reaches `.catch`.
    await Promise.resolve()
    await Promise.resolve()

    expect(warnSpy).toHaveBeenCalledWith(
      'Unable to copy stream id to clipboard:',
      rejection,
    )
  })
})
