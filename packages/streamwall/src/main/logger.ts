import log from 'electron-log/main'

// The file transport is off by default. Merely importing this module (as
// every main-process file that logs will) makes electron-log resolve an app
// name/log path on first write, which throws outside a packaged Electron app
// (e.g. under Vitest, or if package.json can't be found) and would otherwise
// write real log files to the OS log directory as a side effect of running
// the test suite. `initLogger` is the only place that turns the file
// transport on, and it's only called from the real app entrypoint.
log.transports.file.level = false
log.transports.console.level = 'debug'

export const LOG_LEVELS = [
  'error',
  'warn',
  'info',
  'verbose',
  'debug',
  'silly',
] as const

export type LogLevel = (typeof LOG_LEVELS)[number]

/**
 * Enables the userData log file. Call once from the app entrypoint after
 * Electron is ready to report a userData path. Runs before the configured
 * `log.level` is known (parsing the config itself logs), so it always starts
 * at the most verbose level; `setLogLevel` narrows it down afterward.
 */
export function initLogger() {
  log.initialize()
  log.transports.file.level = 'debug'
  log.info('Log file:', log.transports.file.getFile().path)
  return log
}

/** Sets both file and console verbosity, e.g. from the resolved `log.level` config. */
export function setLogLevel(level: LogLevel) {
  log.transports.file.level = level
  log.transports.console.level = level
}

export default log
