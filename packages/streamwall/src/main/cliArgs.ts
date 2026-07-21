import fs from 'fs'
import { join } from 'node:path'
import yargs from 'yargs'
import {
  findUnknownConfigKeys,
  parseConfigToml,
  validateConfig,
} from './config'
import log, { LOG_LEVELS, type LogLevel } from './logger'

export interface StreamwallConfig {
  help: boolean
  log: {
    level: LogLevel
  }
  grid: {
    cols: number
    rows: number
  }
  window: {
    x?: number
    y?: number
    width: number
    height: number
    frameless: boolean
    fullscreen: boolean
    display?: number
    'background-color': string
    'active-color': string
  }
  data: {
    interval: number
    'json-url': string[]
    'toml-file': string[]
  }
  presets: string[]
  streamdelay: {
    endpoint: string
    key: string | null
  }
  control: {
    endpoint: string
  }
  retry: {
    enabled: boolean
    delay: number
    'max-delay': number
    'max-retries': number
    'stalled-timeout': number
  }
  park: {
    pause: boolean
  }
  twitch: {
    channel: string | null
    username: string | null
    token: string | null
    color: string
    announce: {
      template: string
      interval: number
      delay: number
    }
    vote: {
      template: string
      interval: number
    }
  }
  telemetry: {
    sentry: boolean
  }
  playlist: {
    view: number
    interval: number
    urls: string[]
  }[]
}

// Warns (does not throw) about keys in a raw parsed config file that the
// schema doesn't recognize — typos and stale keys (e.g. the removed
// `grid.count`) that would otherwise be silently dropped and fall back to
// defaults with no indication anything was wrong.
function warnUnknownConfigKeys(raw: unknown, source: string) {
  for (const key of findUnknownConfigKeys(raw)) {
    log.warn(`Unknown config key "${key}" in "${source}" is ignored.`)
  }
}

export interface ParseArgsOptions {
  /**
   * Directory holding the user's `config.toml` (Electron's `userData` path in
   * production). Passed in rather than read from `app` so the CLI parsing can
   * be exercised without the Electron runtime.
   */
  configDir: string
  /**
   * Raw process arguments, forwarded verbatim to yargs. In production this is
   * `process.argv`; its first two entries (node + script path) land in
   * `argv._` since no positional commands are defined.
   */
  argv: string[]
}

/**
 * Resolves the effective Streamwall configuration by layering CLI flags over
 * an optional `config.toml` in `configDir` (and any `--config` file), applying
 * schema defaults, and validating the result.
 *
 * Unknown keys in a config file are warned about but not rejected; validation
 * is skipped entirely when only `--help` was requested so an invalid config can
 * never block the help text.
 */
export function parseArgs({
  configDir,
  argv,
}: ParseArgsOptions): StreamwallConfig {
  // Load config from user data dir, if it exists
  const configPath = join(configDir, 'config.toml')
  log.debug('Reading config from ', configPath)

  let configText: string | null = null
  try {
    configText = fs.readFileSync(configPath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err
    }
  }

  const homeConfig = configText ? parseConfigToml(configText, configPath) : {}
  if (configText) {
    warnUnknownConfigKeys(homeConfig, configPath)
  }

  const parsed = yargs()
    .config(homeConfig)
    .config('config', (configFilePath) => {
      const config = parseConfigToml(
        fs.readFileSync(configFilePath, 'utf-8'),
        configFilePath,
      )
      warnUnknownConfigKeys(config, configFilePath)
      return config
    })
    .group(['log.level'], 'Logging')
    .option('log.level', {
      describe:
        'Verbosity of log output, written to both the console and the log file',
      choices: LOG_LEVELS,
      default: 'debug',
    })
    .group(['grid.cols', 'grid.rows'], 'Grid dimensions')
    .option('grid.cols', {
      number: true,
      default: 3,
    })
    .option('grid.rows', {
      number: true,
      default: 3,
    })
    .group(
      [
        'window.width',
        'window.height',
        'window.x',
        'window.y',
        'window.frameless',
        'window.fullscreen',
        'window.display',
        'window.background-color',
        'window.active-color',
      ],
      'Window settings',
    )
    .option('window.x', {
      number: true,
    })
    .option('window.y', {
      number: true,
    })
    .option('window.width', {
      number: true,
      default: 1920,
    })
    .option('window.height', {
      number: true,
      default: 1080,
    })
    .option('window.frameless', {
      boolean: true,
      default: false,
    })
    .option('window.fullscreen', {
      describe: 'Open the wall fullscreen (on the selected display, if any)',
      boolean: true,
      default: false,
    })
    .option('window.display', {
      describe:
        'Index of the display to open the wall on (0-based; see --window.fullscreen)',
      number: true,
    })
    .option('window.background-color', {
      describe: 'Background color of wall (useful for chroma-keying)',
      default: '#000',
    })
    .option('window.active-color', {
      describe: 'Active (highlight) color of wall',
      default: '#fff',
    })
    .group(['data.interval', 'data.json-url', 'data.toml-file'], 'Datasources')
    .option('data.interval', {
      describe: 'Interval (in seconds) for refreshing polled data sources',
      number: true,
      default: 30,
    })
    .option('data.json-url', {
      describe: 'Fetch streams from the specified URL(s)',
      array: true,
      string: true,
      default: [],
    })
    .option('data.toml-file', {
      describe: 'Fetch streams from the specified file(s)',
      normalize: true,
      array: true,
      default: [],
    })
    .group(['presets'], 'Presets')
    .option('presets', {
      describe: 'Enabled built-in preset stream packs (e.g. "de-tv")',
      array: true,
      string: true,
      default: ['de-tv'],
    })
    .group(['streamdelay.endpoint', 'streamdelay.key'], 'Streamdelay')
    .option('streamdelay.endpoint', {
      describe: 'URL of Streamdelay endpoint',
      default: 'http://localhost:8404',
    })
    .option('streamdelay.key', {
      describe: 'Streamdelay API key',
      default: null,
    })
    .group(['control'], 'Remote Control')
    .option('control.endpoint', {
      describe: 'URL of control server endpoint',
      default: null,
    })
    .group(
      [
        'retry.enabled',
        'retry.delay',
        'retry.max-delay',
        'retry.max-retries',
        'retry.stalled-timeout',
      ],
      'Auto-retry',
    )
    .option('retry.enabled', {
      describe: 'Automatically reload views that error or stall',
      boolean: true,
      default: true,
    })
    .option('retry.delay', {
      describe: 'Base backoff (in seconds) before the first reload',
      number: true,
      default: 5,
    })
    .option('retry.max-delay', {
      describe: 'Maximum backoff (in seconds) between reloads',
      number: true,
      default: 60,
    })
    .option('retry.max-retries', {
      describe: 'Maximum number of automatic reloads before giving up',
      number: true,
      default: 5,
    })
    .option('retry.stalled-timeout', {
      describe: 'How long (in seconds) a view may stall before it is reloaded',
      number: true,
      default: 30,
    })
    .group(['park.pause'], 'Fullscreen Parking')
    .option('park.pause', {
      describe:
        'Pause playback of parked (hidden) views instead of keeping them fully live while a stream is expanded to fullscreen',
      boolean: true,
      default: false,
    })
    .group(
      [
        'twitch.channel',
        'twitch.username',
        'twitch.token',
        'twitch.color',
        'twitch.announce.template',
        'twitch.announce.interval',
        'twitch.vote.template',
        'twitch.vote.interval',
      ],
      'Twitch Chat',
    )
    .option('twitch.channel', {
      describe: 'Name of Twitch channel',
      default: null,
    })
    .option('twitch.username', {
      describe: 'Username of Twitch bot account',
      default: null,
    })
    .option('twitch.token', {
      describe: 'Password of Twitch bot account',
      default: null,
    })
    .option('twitch.color', {
      describe: 'Color of Twitch bot username',
      default: '#ff0000',
    })
    .option('twitch.announce.template', {
      describe: 'Message template for stream announcements',
      default:
        'SingsMic <%- stream.source %> <%- stream.city && stream.state ? `(${stream.city} ${stream.state})` : `` %> <%- stream.link %>',
    })
    .option('twitch.announce.interval', {
      describe:
        'Minimum time interval (in seconds) between re-announcing the same stream',
      number: true,
      default: 60,
    })
    .option('twitch.announce.delay', {
      describe: 'Time to dwell on a stream before its details are announced',
      number: true,
      default: 30,
    })
    .option('twitch.vote.template', {
      describe: 'Message template for vote result announcements',
      default: 'Switching to #<%- selectedIdx %> (with <%- voteCount %> votes)',
    })
    .option('twitch.vote.interval', {
      describe: 'Time interval (in seconds) between votes (0 to disable)',
      number: true,
      default: 0,
    })
    .group(['telemetry.sentry'], 'Telemetry')
    .option('telemetry.sentry', {
      describe: 'Enable error reporting to Sentry',
      boolean: true,
      default: true,
    })
    // Configured only via `[[playlist]]` tables in config.toml (or --config);
    // not exposed as an individual CLI flag since it's a list of tables.
    .option('playlist', {
      default: [],
    })
    .help()
    // https://github.com/yargs/yargs/issues/2137
    .parseSync(argv) as unknown as StreamwallConfig

  // Skip validation when the user only asked for --help, so an invalid config
  // can never block the help text from being shown.
  if (!parsed.help) {
    validateConfig(parsed)
  }
  return parsed
}
