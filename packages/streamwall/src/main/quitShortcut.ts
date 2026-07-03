import type { App, BrowserWindow, GlobalShortcut } from 'electron'

/**
 * Platform-standard quit accelerator (Cmd+Q on macOS, Ctrl+Q elsewhere).
 */
export const QUIT_ACCELERATOR = 'CommandOrControl+Q'

export interface QuitShortcutOptions {
  app: Pick<App, 'on' | 'quit'>
  globalShortcut: Pick<
    GlobalShortcut,
    'register' | 'unregister' | 'isRegistered'
  >
  getFocusedWindow: () => BrowserWindow | null
  /**
   * Defers a callback to a later tick. Injectable for testing; defaults to
   * `setImmediate`.
   */
  defer?: (cb: () => void) => void
}

/**
 * Registers a keyboard shortcut to quit the application while one of its
 * windows is focused.
 *
 * This is the only in-app way to exit when the stream window is configured to
 * be frameless (`window.frameless = true`): a frameless window has no title bar
 * or close button, and the menu is removed, so there is otherwise no way to
 * trigger a quit from within the app.
 *
 * The shortcut is scoped to application focus so it does not hijack the
 * accelerator system-wide: it is registered whenever an app window gains focus
 * and unregistered once the app loses focus entirely.
 */
export function setupQuitShortcut({
  app,
  globalShortcut,
  getFocusedWindow,
  defer = (cb) => {
    setImmediate(cb)
  },
}: QuitShortcutOptions): void {
  const register = () => {
    if (!globalShortcut.isRegistered(QUIT_ACCELERATOR)) {
      globalShortcut.register(QUIT_ACCELERATOR, () => app.quit())
    }
  }

  const unregister = () => {
    if (globalShortcut.isRegistered(QUIT_ACCELERATOR)) {
      globalShortcut.unregister(QUIT_ACCELERATOR)
    }
  }

  app.on('browser-window-focus', register)

  app.on('browser-window-blur', () => {
    // Defer so that, when switching between the app's own windows, the focus of
    // the newly focused window settles before we decide whether the app lost
    // focus entirely. Otherwise a window switch (blur old, focus new) could
    // leave the shortcut unregistered while the app is still focused.
    defer(() => {
      if (!getFocusedWindow()) {
        unregister()
      }
    })
  })

  app.on('will-quit', unregister)

  // A window may already be focused by the time this runs (e.g. the stream
  // window was shown before setup); register eagerly in that case.
  if (getFocusedWindow()) {
    register()
  }
}
