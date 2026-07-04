import { describe, expect, test } from 'vitest'
import { ConfigError, parseConfigToml, validateConfig } from './config'

/** A structurally-complete config, as produced by yargs after defaults. */
function baseConfig() {
  return {
    help: false,
    grid: { cols: 3, rows: 3 },
    window: {
      width: 1920,
      height: 1080,
      frameless: false,
      'background-color': '#000',
      'active-color': '#fff',
    },
    data: { interval: 30, 'json-url': [], 'toml-file': [] },
    streamdelay: { endpoint: 'http://localhost:8404', key: null },
    control: { endpoint: null },
    twitch: {
      channel: null,
      username: null,
      token: null,
      color: '#ff0000',
      announce: { template: 't', interval: 60, delay: 30 },
      vote: { template: 't', interval: 0 },
    },
    telemetry: { sentry: true },
  }
}

describe('parseConfigToml', () => {
  test('parses valid TOML', () => {
    const result = parseConfigToml('[grid]\ncols = 4\n', 'config.toml')
    expect(result).toEqual({ grid: { cols: 4 } })
  })

  test('throws a ConfigError naming the file on malformed TOML', () => {
    expect(() => parseConfigToml('broken ==', '/path/config.toml')).toThrow(
      ConfigError,
    )
    try {
      parseConfigToml('broken ==', '/path/config.toml')
    } catch (err) {
      expect((err as Error).message).toContain('/path/config.toml')
      // The underlying parser reports the row/col, which we surface.
      expect((err as Error).message).toMatch(/row|col/i)
    }
  })
})

describe('validateConfig', () => {
  test('accepts a valid config', () => {
    expect(() => validateConfig(baseConfig())).not.toThrow()
  })

  test('accepts a config with an optional window position', () => {
    const config = baseConfig()
    ;(config.window as Record<string, unknown>).x = 100
    ;(config.window as Record<string, unknown>).y = 50
    expect(() => validateConfig(config)).not.toThrow()
  })

  test('ignores extra keys added by yargs', () => {
    const config = {
      ...baseConfig(),
      _: [],
      $0: 'streamwall',
      backgroundColor: '#000',
    }
    expect(() => validateConfig(config)).not.toThrow()
  })

  test('rejects a non-numeric grid dimension and names the key', () => {
    const config = baseConfig()
    config.grid.cols = Number.NaN
    expect(() => validateConfig(config)).toThrow(ConfigError)
    try {
      validateConfig(config)
    } catch (err) {
      expect((err as Error).message).toContain('cols')
    }
  })

  test('rejects a non-positive window dimension and names the key', () => {
    const config = baseConfig()
    config.window.width = -5
    try {
      validateConfig(config)
      throw new Error('expected validateConfig to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError)
      expect((err as Error).message).toContain('width')
    }
  })

  test('rejects a negative data interval', () => {
    const config = baseConfig()
    config.data.interval = -1
    expect(() => validateConfig(config)).toThrow(ConfigError)
  })

  test('rejects a non-string window color', () => {
    const config = baseConfig()
    ;(config.window as Record<string, unknown>)['background-color'] = 123
    expect(() => validateConfig(config)).toThrow(ConfigError)
  })
})
