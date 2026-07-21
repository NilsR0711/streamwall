import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseArgs } from './cliArgs'
import { ConfigError } from './config'
import log from './logger'

// yargs lands the first two argv entries (node + script path) in `argv._`,
// mirroring how `process.argv` is forwarded in production.
function argv(...flags: string[]): string[] {
  return ['node', 'streamwall', ...flags]
}

describe('parseArgs', () => {
  let configDir: string
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'streamwall-cliargs-'))
    warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => log)
  })

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('applies schema defaults when no config file and no flags are given', () => {
    const config = parseArgs({ configDir, argv: argv() })

    expect(config.grid).toEqual({ cols: 3, rows: 3 })
    expect(config.window.width).toBe(1920)
    expect(config.window.height).toBe(1080)
    expect(config.presets).toEqual(['de-tv'])
    expect(config.retry.enabled).toBe(true)
    expect(config.telemetry.sentry).toBe(true)
    expect(config.control.endpoint).toBeNull()
    expect(config.playlist).toEqual([])
  })

  it('lets CLI flags override defaults', () => {
    const config = parseArgs({
      configDir,
      argv: argv(
        '--grid.cols',
        '4',
        '--grid.rows',
        '2',
        '--window.width',
        '800',
      ),
    })

    expect(config.grid).toEqual({ cols: 4, rows: 2 })
    expect(config.window.width).toBe(800)
  })

  it('reads config.toml from the config dir', () => {
    writeFileSync(
      join(configDir, 'config.toml'),
      '[grid]\ncols = 5\nrows = 4\n',
    )

    const config = parseArgs({ configDir, argv: argv() })

    expect(config.grid).toEqual({ cols: 5, rows: 4 })
  })

  it('lets CLI flags take precedence over config.toml', () => {
    writeFileSync(join(configDir, 'config.toml'), '[grid]\ncols = 5\n')

    const config = parseArgs({ configDir, argv: argv('--grid.cols', '2') })

    expect(config.grid.cols).toBe(2)
  })

  it('warns about unknown keys in config.toml without throwing', () => {
    // `grid.count` was removed in favour of grid.cols/grid.rows; it must be
    // surfaced rather than silently dropped.
    writeFileSync(join(configDir, 'config.toml'), '[grid]\ncount = 5\n')

    const config = parseArgs({ configDir, argv: argv() })

    // The unknown key is warned about but not stripped; the known defaults
    // still apply.
    expect(config.grid.cols).toBe(3)
    expect(config.grid.rows).toBe(3)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unknown config key "grid.count"'),
    )
  })

  it('layers a --config file over the home config', () => {
    writeFileSync(join(configDir, 'config.toml'), '[grid]\ncols = 5\n')
    const extraConfig = join(configDir, 'extra.toml')
    writeFileSync(extraConfig, '[grid]\nrows = 6\n')

    const config = parseArgs({
      configDir,
      argv: argv('--config', extraConfig),
    })

    expect(config.grid).toEqual({ cols: 5, rows: 6 })
  })

  it('throws a ConfigError when a value is out of range', () => {
    expect(() =>
      parseArgs({ configDir, argv: argv('--window.width', '0') }),
    ).toThrow(ConfigError)
  })

  it('ignores a missing config.toml (ENOENT) and falls back to defaults', () => {
    // configDir exists but holds no config.toml.
    const config = parseArgs({ configDir, argv: argv() })

    expect(config.grid).toEqual({ cols: 3, rows: 3 })
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
