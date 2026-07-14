import '@sentry/electron/preload'
import { contextBridge } from 'electron'
import { isSentryEnabledArg } from '../sentryConfig'

// Import for the side effect only: it wires up the sandboxed IPC transport
// `@sentry/electron/renderer`'s init() needs to forward events to the main
// process. Only pull this into preloads for renderers the app fully authors
// (control, background, overlay) -- never into a preload facing arbitrary
// third-party content.
contextBridge.exposeInMainWorld(
  'sentryEnabled',
  isSentryEnabledArg(process.argv),
)
