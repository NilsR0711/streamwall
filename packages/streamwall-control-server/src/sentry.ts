import * as Sentry from '@sentry/node'

/**
 * Unlike the Electron app (which ships a DSN for the maintainer's own Sentry
 * project), this server is self-hosted by independent operators. There is no
 * sensible default DSN to bundle, so crash reporting stays off unless an
 * operator both opts in and supplies their own project's DSN.
 */
export const SENTRY_ENABLED_ENV = 'STREAMWALL_SENTRY_ENABLED'
export const SENTRY_DSN_ENV = 'STREAMWALL_SENTRY_DSN'

export interface SentryConfig {
  enabled: boolean
  dsn: string | undefined
}

/** Reads the crash-reporting configuration from the environment. */
export function getSentryConfig(): SentryConfig {
  return {
    enabled: process.env[SENTRY_ENABLED_ENV] === 'true',
    dsn: process.env[SENTRY_DSN_ENV],
  }
}

/** The subset of the Sentry client this module depends on, for injection in tests. */
export interface SentryClient {
  init(options: { dsn: string }): void
}

/**
 * Initializes Sentry crash reporting if enabled and configured. Returns
 * whether initialization happened, so callers can decide whether to also wire
 * up framework-specific error capture (e.g. Fastify's error handler).
 */
export function initSentry(
  config: SentryConfig = getSentryConfig(),
  client: SentryClient = Sentry,
): boolean {
  if (!config.enabled) {
    return false
  }
  if (!config.dsn) {
    console.warn(
      `${SENTRY_ENABLED_ENV} is set but ${SENTRY_DSN_ENV} is missing; skipping Sentry initialization.`,
    )
    return false
  }
  client.init({ dsn: config.dsn })
  return true
}

/** The subset of the Sentry client this module depends on to report caught errors, for injection in tests. */
export interface SentryCaptureClient {
  captureException(err: unknown): unknown
}

/**
 * Reports an already-caught error to Sentry when crash reporting is enabled.
 * Takes `enabled` explicitly (the value `initSentry()` returned) rather than
 * tracking module-level state, so this stays a pure function callers can
 * unit test without depending on a prior `initSentry()` call.
 */
export function captureException(
  err: unknown,
  enabled: boolean,
  client: SentryCaptureClient = Sentry,
): void {
  if (!enabled) {
    return
  }
  client.captureException(err)
}
