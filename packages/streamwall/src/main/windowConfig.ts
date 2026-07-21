import { type StreamWindowConfig } from 'streamwall-shared'
import { type StreamwallConfig } from './cliArgs'
import { type RetryConfig } from './viewStateMachine'

/**
 * Projects the resolved CLI/config into the wall window's geometry and grid
 * config. The returned object is shared by reference with the StreamWindow and
 * the broadcast client state, so a runtime grid resize (which mutates it in
 * place) stays visible to both.
 */
export function buildStreamWindowConfig(
  argv: StreamwallConfig,
): StreamWindowConfig {
  return {
    cols: argv.grid.cols,
    rows: argv.grid.rows,
    width: argv.window.width,
    height: argv.window.height,
    x: argv.window.x,
    y: argv.window.y,
    frameless: argv.window.frameless,
    fullscreen: argv.window.fullscreen,
    display: argv.window.display,
    activeColor: argv.window['active-color'],
    backgroundColor: argv.window['background-color'],
  }
}

/**
 * Projects the retry CLI/config into the view state machine's RetryConfig.
 *
 * The state machine works in milliseconds; the config is expressed in seconds
 * for consistency with the other interval options, so the second-valued fields
 * are converted here.
 */
export function buildRetryConfig(argv: StreamwallConfig): RetryConfig {
  return {
    enabled: argv.retry.enabled,
    delay: argv.retry.delay * 1000,
    maxDelay: argv.retry['max-delay'] * 1000,
    maxRetries: argv.retry['max-retries'],
    stalledTimeout: argv.retry['stalled-timeout'] * 1000,
  }
}
