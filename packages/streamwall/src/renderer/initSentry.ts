import * as Sentry from '@sentry/electron/renderer'
import { SENTRY_DSN } from '../sentryConfig'

declare global {
  interface Window {
    /** Set by the window's preload script (see sentryPreload.ts). */
    sentryEnabled: boolean
  }
}

/**
 * Initializes Sentry in a trusted renderer (control, background, overlay).
 * Only call this from renderers the app fully authors -- never from a
 * renderer that can navigate to arbitrary third-party content (e.g. the
 * per-stream views), since that would leak that page's context to Sentry.
 */
export function initRendererSentry(): void {
  if (window.sentryEnabled) {
    Sentry.init({ dsn: SENTRY_DSN })
  }
}
