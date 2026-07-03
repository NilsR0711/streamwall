import type { WebContents } from 'electron'

// A navigation event as surfaced by Electron's `will-navigate` / `will-redirect`.
// Declared as a structural subset of Electron's event so the guards below can be
// exercised without a running Electron app.
interface NavigationEvent {
  readonly url: string
  preventDefault(): void
}

// Deny renderer-initiated popups (window.open, target="_blank", …). Neither a
// loaded stream page nor a browsed page should ever be able to spawn a window.
export function denyWindowOpen(webContents: WebContents): void {
  webContents.setWindowOpenHandler(() => ({ action: 'deny' as const }))
}

// Keep a view pinned to its intended URL while still letting it reload itself.
// Used for both `will-navigate` and `will-redirect`: a 302 on a reload bypasses
// the `will-navigate` check, so the same guard must cover redirects too.
function preventNavigationAway(
  webContents: WebContents,
  event: NavigationEvent,
): void {
  const currentURL = webContents.getURL()

  // Allow the page to reload itself (navigating to the URL it is already on).
  if (event.url === currentURL) {
    console.log('Allowing page to reload:', event.url)
    return
  }

  // Allow the initial load to resolve through server redirects. Until the view
  // commits a page, `getURL()` is empty; the operator-supplied URL's own 302s
  // (http->https, CDN, shortlinks) fire `will-redirect` even though the load was
  // started from the main process, and must not be blocked.
  if (currentURL === '') {
    return
  }

  event.preventDefault()
}

// Lock a stream view's web contents down: deny popups and block both navigation
// and redirect escapes away from the intended URL, while permitting self-reloads.
export function secureStreamView(webContents: WebContents): void {
  denyWindowOpen(webContents)

  const guard = (event: NavigationEvent) =>
    preventNavigationAway(webContents, event)
  webContents.on('will-navigate', guard)
  webContents.on('will-redirect', guard)
}
