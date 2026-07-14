export const SENTRY_DSN =
  'https://e630a21dcf854d1a9eb2a7a8584cbd0b@o459879.ingest.sentry.io/5459505'

/**
 * Command-line switch name main/index.ts sets via `app.commandLine.appendSwitch`
 * once `telemetry.sentry` is known. Sandboxed preload scripts run in their own
 * process with no other channel to main-process config, so this is how they
 * learn whether the trusted renderers they front (control, background,
 * overlay) should initialize Sentry.
 */
export const SENTRY_ENABLED_SWITCH = 'sentry-enabled'

export function sentryEnabledSwitchValue(enabled: boolean): string {
  return String(enabled)
}

export function isSentryEnabledArg(argv: readonly string[]): boolean {
  return argv.includes(`--${SENTRY_ENABLED_SWITCH}=true`)
}
