import { describe, expect, it } from 'vitest'
import { type StreamwallConfig } from './cliArgs'
import { buildRetryConfig, buildStreamWindowConfig } from './windowConfig'

function baseArgv(overrides: Partial<StreamwallConfig> = {}): StreamwallConfig {
  return {
    help: false,
    log: { level: 'debug' },
    grid: { cols: 3, rows: 2 },
    window: {
      x: 10,
      y: 20,
      width: 1920,
      height: 1080,
      frameless: true,
      fullscreen: false,
      display: 1,
      'background-color': '#111',
      'active-color': '#eee',
    },
    data: { interval: 30, 'json-url': [], 'toml-file': [] },
    presets: [],
    streamdelay: { endpoint: 'http://localhost:8404', key: null },
    control: { endpoint: '' },
    retry: {
      enabled: true,
      delay: 5,
      'max-delay': 60,
      'max-retries': 4,
      'stalled-timeout': 30,
    },
    park: { pause: false },
    twitch: {
      channel: null,
      username: null,
      token: null,
      color: '#ff0000',
      announce: { template: 't', interval: 60, delay: 30 },
      vote: { template: 't', interval: 0 },
    },
    telemetry: { sentry: true },
    playlist: [],
    ...overrides,
  }
}

describe('buildStreamWindowConfig', () => {
  it('projects grid and window options into the wall config', () => {
    expect(buildStreamWindowConfig(baseArgv())).toEqual({
      cols: 3,
      rows: 2,
      width: 1920,
      height: 1080,
      x: 10,
      y: 20,
      frameless: true,
      fullscreen: false,
      display: 1,
      activeColor: '#eee',
      backgroundColor: '#111',
    })
  })
})

describe('buildRetryConfig', () => {
  it('converts the second-valued fields to milliseconds', () => {
    expect(buildRetryConfig(baseArgv())).toEqual({
      enabled: true,
      delay: 5000,
      maxDelay: 60000,
      maxRetries: 4,
      stalledTimeout: 30000,
    })
  })

  it('preserves the enabled flag and retry count verbatim', () => {
    const config = buildRetryConfig(
      baseArgv({
        retry: {
          enabled: false,
          delay: 2,
          'max-delay': 10,
          'max-retries': 0,
          'stalled-timeout': 15,
        },
      }),
    )
    expect(config.enabled).toBe(false)
    expect(config.maxRetries).toBe(0)
    expect(config.delay).toBe(2000)
  })
})
