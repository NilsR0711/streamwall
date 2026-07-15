import { ConfigError } from './config'

export type ConfigInitErrorOutcome =
  { action: 'exit'; message: string; exitCode: 1 } | { action: 'rethrow' }

/**
 * Maps a config/bootstrap failure during app init to either a clean exit or a
 * rethrow for unexpected errors.
 */
export function resolveConfigInitError(err: unknown): ConfigInitErrorOutcome {
  if (err instanceof ConfigError) {
    return { action: 'exit', message: err.message, exitCode: 1 }
  }

  return { action: 'rethrow' }
}
