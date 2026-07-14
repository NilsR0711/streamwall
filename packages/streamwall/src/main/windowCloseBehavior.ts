/**
 * On macOS the convention is that closing a window hides it rather than
 * quitting the app -- the app stays in the dock and reopens the window on
 * "activate" (dock icon click). Every other platform quits when its main
 * window closes.
 */
export function shouldHideInsteadOfQuit(
  platform: NodeJS.Platform,
  isQuitting: boolean,
): boolean {
  return platform === 'darwin' && !isQuitting
}

/**
 * Standard Electron convention: once every window has closed, quit the app.
 * macOS is the exception -- the app (and its dock icon) stays running with no
 * windows open until the user explicitly quits.
 */
export function shouldQuitOnAllWindowsClosed(
  platform: NodeJS.Platform,
): boolean {
  return platform !== 'darwin'
}
