import type { WebContents } from 'electron'
import log from './logger'

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
): boolean {
  const currentURL = webContents.getURL()

  // Allow the page to reload itself (navigating to the URL it is already on).
  if (event.url === currentURL) {
    log.info('Allowing page to reload:', event.url)
    return false
  }

  // Allow the initial load to resolve through server redirects. Until the view
  // commits a page, `getURL()` is empty; the operator-supplied URL's own 302s
  // (http->https, CDN, shortlinks) fire `will-redirect` even though the load was
  // started from the main process, and must not be blocked.
  if (currentURL === '') {
    return false
  }

  event.preventDefault()
  return true
}

// The only schemes we are willing to hand to the OS browser. Anything else
// (file:, javascript:, a custom protocol registered by another installed app)
// is dropped rather than launched: the URL originates from operator- or
// control-server-supplied stream data, so `shell.openExternal` on it would be a
// launch-anything gadget.
const EXTERNALLY_OPENABLE_PROTOCOLS = new Set(['http:', 'https:'])

function isExternallyOpenable(url: string): boolean {
  try {
    return EXTERNALLY_OPENABLE_PROTOCOLS.has(new URL(url).protocol)
  } catch {
    return false
  }
}

// Lock a stream view's web contents down: deny popups and block both navigation
// and redirect escapes away from the intended URL, while permitting self-reloads.
export function secureStreamView(webContents: WebContents): void {
  denyWindowOpen(webContents)

  const guard = (event: NavigationEvent) => {
    preventNavigationAway(webContents, event)
  }
  webContents.on('will-navigate', guard)
  webContents.on('will-redirect', guard)
}

/**
 * Lock a window that renders Streamwall's own bundled UI (currently the control
 * window) to that UI, and route outward links to the OS browser instead.
 *
 * The control window holds the `streamwallControl` bridge, and every `control:*`
 * IPC guard compares `ev.sender` against this very webContents — so a navigation
 * to remote content would hand that page the full bridge while still passing
 * every sender check. control.html's `<meta>` CSP is a property of the local
 * document and does not survive such a navigation either (#732).
 *
 * `openExternal` is injected rather than imported so the guards stay testable
 * without a running Electron app; callers pass `shell.openExternal`.
 */
export function secureAppWindow(
  webContents: WebContents,
  openExternal: (url: string) => void,
): void {
  webContents.setWindowOpenHandler(({ url }) => {
    if (isExternallyOpenable(url)) {
      openExternal(url)
    }
    return { action: 'deny' as const }
  })

  const guard = (event: NavigationEvent) => {
    if (!preventNavigationAway(webContents, event)) {
      return
    }
    // The click was a deliberate "take me to this stream"; honour the intent in
    // the OS browser, where the page gets none of the app's privileges.
    if (isExternallyOpenable(event.url)) {
      openExternal(event.url)
    }
  }
  webContents.on('will-navigate', guard)
  webContents.on('will-redirect', guard)
}
