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
