import { describe, expect, test } from 'vitest'
import {
  ConfigError,
  findUnknownConfigKeys,
  parseConfigToml,
  validateConfig,
} from './config'

/** A structurally-complete config, as produced by yargs after defaults. */
function baseConfig() {
  return {
    help: false,
    grid: { cols: 3, rows: 3 },
    window: {
      width: 1920,
      height: 1080,
      frameless: false,
      fullscreen: false,
      'background-color': '#000',
      'active-color': '#fff',
    },
    data: { interval: 30, 'json-url': [], 'toml-file': [] },
    streamdelay: { endpoint: 'http://localhost:8404', key: null },
    control: { endpoint: null },
    retry: {
      enabled: true,
      delay: 5,
      'max-delay': 60,
      'max-retries': 5,
      'stalled-timeout': 30,
    },
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

  test('accepts a config selecting a target display', () => {
    const config = baseConfig()
    ;(config.window as Record<string, unknown>).display = 1
    expect(() => validateConfig(config)).not.toThrow()
  })

  test('accepts window.fullscreen enabled', () => {
    const config = baseConfig()
    config.window.fullscreen = true
    expect(() => validateConfig(config)).not.toThrow()
  })

  test('rejects a negative window.display and names the key', () => {
    const config = baseConfig()
    ;(config.window as Record<string, unknown>).display = -1
    expect(() => validateConfig(config)).toThrow(ConfigError)
    try {
      validateConfig(config)
    } catch (err) {
      expect((err as Error).message).toContain('display')
    }
  })

  test('rejects a fractional window.display', () => {
    const config = baseConfig()
    ;(config.window as Record<string, unknown>).display = 1.5
    expect(() => validateConfig(config)).toThrow(ConfigError)
  })

  test('rejects a non-boolean window.fullscreen', () => {
    const config = baseConfig()
    ;(config.window as Record<string, unknown>).fullscreen = 'yes'
    expect(() => validateConfig(config)).toThrow(ConfigError)
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

  test('rejects a grid dimension above the supported maximum', () => {
    // The grid caps must match the WS command schema (GRID_MAX = 8) so a
    // configured wall can always be targeted and resized by remote commands.
    const config = baseConfig()
    config.grid.cols = 10
    expect(() => validateConfig(config)).toThrow(ConfigError)
    try {
      validateConfig(config)
    } catch (err) {
      expect((err as Error).message).toContain('cols')
    }
  })

  test('rejects a grid dimension below the supported minimum', () => {
    const config = baseConfig()
    config.grid.rows = 0
    expect(() => validateConfig(config)).toThrow(ConfigError)
  })

  test('accepts grid dimensions at the maximum', () => {
    const config = baseConfig()
    config.grid.cols = 8
    config.grid.rows = 8
    expect(() => validateConfig(config)).not.toThrow()
  })

  test('rejects a non-string window color', () => {
    const config = baseConfig()
    ;(config.window as Record<string, unknown>)['background-color'] = 123
    expect(() => validateConfig(config)).toThrow(ConfigError)
  })

  test('accepts retry disabled with zeroed timings', () => {
    const config = baseConfig()
    config.retry = {
      enabled: false,
      delay: 0,
      'max-delay': 0,
      'max-retries': 0,
      'stalled-timeout': 0,
    }
    expect(() => validateConfig(config)).not.toThrow()
  })

  test('rejects a negative retry delay', () => {
    const config = baseConfig()
    config.retry.delay = -1
    expect(() => validateConfig(config)).toThrow(ConfigError)
  })

  test('rejects a fractional retry max-retries', () => {
    const config = baseConfig()
    config.retry['max-retries'] = 2.5
    expect(() => validateConfig(config)).toThrow(ConfigError)
  })

  test('accepts a config with no playlist entries', () => {
    const config = { ...baseConfig(), playlist: [] }
    expect(() => validateConfig(config)).not.toThrow()
  })

  test('accepts a valid playlist entry targeting an in-bounds view', () => {
    const config = {
      ...baseConfig(),
      playlist: [{ view: 8, interval: 60, urls: ['https://a', 'https://b'] }],
    }
    expect(() => validateConfig(config)).not.toThrow()
  })

  test('rejects a playlist entry with an empty urls list', () => {
    const config = {
      ...baseConfig(),
      playlist: [{ view: 0, interval: 60, urls: [] }],
    }
    expect(() => validateConfig(config)).toThrow(ConfigError)
  })

  test('rejects a playlist entry with a non-positive interval', () => {
    const config = {
      ...baseConfig(),
      playlist: [{ view: 0, interval: 0, urls: ['https://a'] }],
    }
    expect(() => validateConfig(config)).toThrow(ConfigError)
  })

  test('rejects a playlist entry targeting a view outside the configured grid', () => {
    // grid is 3x3 by default, so views run 0-8.
    const config = {
      ...baseConfig(),
      playlist: [{ view: 9, interval: 60, urls: ['https://a'] }],
    }
    expect(() => validateConfig(config)).toThrow(ConfigError)
    try {
      validateConfig(config)
    } catch (err) {
      expect((err as Error).message).toContain('view 9')
    }
  })

  test('rejects two playlist entries targeting the same view', () => {
    const config = {
      ...baseConfig(),
      playlist: [
        { view: 0, interval: 60, urls: ['https://a'] },
        { view: 0, interval: 30, urls: ['https://b'] },
      ],
    }
    expect(() => validateConfig(config)).toThrow(ConfigError)
  })

  test('accepts each supported log level', () => {
    for (const level of [
      'error',
      'warn',
      'info',
      'verbose',
      'debug',
      'silly',
    ]) {
      const config = { ...baseConfig(), log: { level } }
      expect(() => validateConfig(config)).not.toThrow()
    }
  })

  test('rejects an unsupported log level and names the key', () => {
    const config = { ...baseConfig(), log: { level: 'chatty' } }
    expect(() => validateConfig(config)).toThrow(ConfigError)
    try {
      validateConfig(config)
    } catch (err) {
      expect((err as Error).message).toContain('level')
    }
  })
})

describe('findUnknownConfigKeys', () => {
  test('returns nothing for a raw config using only known keys', () => {
    expect(
      findUnknownConfigKeys({
        grid: { cols: 4, rows: 3 },
        window: { width: 1920 },
      }),
    ).toEqual([])
  })

  test('names a top-level unknown key', () => {
    expect(findUnknownConfigKeys({ grid: { cols: 4 }, cert: {} })).toEqual([
      'cert',
    ])
  })

  test('names a removed nested key, e.g. the old grid.count', () => {
    expect(findUnknownConfigKeys({ grid: { count: 3 } })).toEqual([
      'grid.count',
    ])
  })

  test('names a misspelled nested key', () => {
    expect(findUnknownConfigKeys({ grid: { colls: 4 } })).toEqual([
      'grid.colls',
    ])
  })

  test('reports multiple unknown keys across sections', () => {
    expect(
      findUnknownConfigKeys({
        grid: { cols: 4, count: 3 },
        twitch: { announce: { tempalte: 't' } },
      }),
    ).toEqual(['grid.count', 'twitch.announce.tempalte'])
  })

  test('does not descend into a key whose value is not a config section', () => {
    // grid.cols is a number in the schema, not an object — an operator
    // accidentally nesting a table under it should be reported once, not
    // walked into.
    expect(findUnknownConfigKeys({ grid: { cols: { nested: true } } })).toEqual(
      [],
    )
  })

  test('ignores the CLI-only help flag and non-object input', () => {
    expect(findUnknownConfigKeys({ help: true })).toEqual([])
    expect(findUnknownConfigKeys(null)).toEqual([])
    expect(findUnknownConfigKeys('not an object')).toEqual([])
  })
})
