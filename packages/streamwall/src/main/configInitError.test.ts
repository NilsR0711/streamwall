import { describe, expect, it } from 'vitest'
import { ConfigError } from './config'
import { resolveConfigInitError } from './configInitError'

describe('resolveConfigInitError', () => {
  it('returns a clean exit outcome for a ConfigError', () => {
    const err = new ConfigError(
      'Invalid config in "/tmp/config.toml": bad grid.cols',
    )

    expect(resolveConfigInitError(err)).toEqual({
      action: 'exit',
      message: err.message,
      exitCode: 1,
    })
  })

  it('rethrows unexpected errors', () => {
    const err = new Error('disk full')

    expect(resolveConfigInitError(err)).toEqual({ action: 'rethrow' })
  })
})
