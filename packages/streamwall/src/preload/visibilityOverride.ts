import type { WebFrame } from 'electron'

/**
 * Spoofs `document.visibilityState`/`hidden` as visible and fires
 * `visibilitychange`, so that sites which pause media when they believe they
 * are hidden or backgrounded keep playing on an offscreen/background tile.
 */
export function overrideVisibility(): void {
  Object.defineProperty(document, 'visibilityState', {
    value: 'visible',
    writable: true,
  })
  Object.defineProperty(document, 'hidden', {
    value: false,
    writable: true,
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

// Serialized so it can be run via `executeJavaScript` in the main world: with
// contextIsolation enabled, calling `overrideVisibility()` directly from the
// preload's own isolated `document` wrapper would not be visible to the
// page's own scripts (see `lockdownMediaTags` in mediaPreload.ts for the same
// pattern applied to media elements).
export const VISIBILITY_OVERRIDE_SCRIPT = `(${overrideVisibility})()`

/**
 * Applies the override for the currently loaded document. Must be called
 * from preload, which runs before the page's own scripts on every
 * navigation. Running it beforehand against a webContents that is about to
 * navigate (e.g. before `loadURL`) targets the pre-navigation document, which
 * `loadURL` discards, making the call a no-op (see #25).
 */
export function installVisibilityOverride(
  webFrame: Pick<WebFrame, 'executeJavaScript'>,
): void {
  webFrame.executeJavaScript(VISIBILITY_OVERRIDE_SCRIPT)
}
