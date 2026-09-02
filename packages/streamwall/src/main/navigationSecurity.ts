import type { WebContents } from 'electron'
import log from './logger'

// A navigation event as surfaced by Electron's `will-navigate` / `will-redirect`.
// Declared as a structural subset of Electron's event so the guards below can be
// exercised without a running Electron app.
interface NavigationEvent {
  readonly url: string
  // `will-redirect` fires for sub-frames as well as the main frame. Optional
  // because `secureStreamView`'s guard does not read it (see #794).
  readonly isMainFrame?: boolean
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
    log.info('Allowing page to reload:', redactURL(event.url))
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

// Where a link points, without what it carries. The URLs reaching these guards
// are renderer-supplied and can hold credentials -- an invite link keeps its
// token in the fragment -- while `initLogger` persists everything from `info`
// down to the user data log file, so the query and fragment must never reach it.
function redactURL(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return '<unparseable URL>'
  }
  const { protocol, host, pathname } = parsed
  if (host) {
    // Drops any `user:password@` userinfo along with the query and fragment.
    return `${protocol}//${host}${pathname}`
  }
  if (protocol === 'file:') {
    return `${protocol}//${pathname}`
  }
  // An opaque-path scheme (data:, javascript:, mailto:, about:) carries its
  // whole payload in the path, so only the scheme is safe to write down.
  return `${protocol}<opaque>`
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
 * Unlike `secureStreamView`, which pins a view to whatever it has committed,
 * this names the allowed page up front: the page is loaded from disk (or the dev
 * server) by the main process, so there is no operator-supplied redirect chain
 * to leave room for and no window in which nothing has committed yet. The
 * committed URL is accepted as well, so a self-reload survives even if Electron
 * spells the loaded `file:` URL slightly differently than `appPageURL` does --
 * that URL can only ever be an app page, since nothing else is allowed to
 * commit.
 *
 * `openExternal` is stated rather than defaulted: the control window hands an
 * outward link to the OS browser because an operator is sitting in front of it,
 * while the wall's chrome layers -- which nobody is sitting at, and whose
 * content is operator-supplied -- pass `null` and get no outward path at all
 * (#776). Nullable rather than optional so a new caller cannot lose the outward
 * path by forgetting the field.
 *
 * `allowSubframeNavigation` is likewise opt-in. `will-redirect` fires for
 * sub-frames as well as the main frame, and the chrome layers exist to host
 * third-party iframes whose own 302s (shortlinks, http->https, CDNs) have to
 * resolve -- those requests are governed at the network layer by the session's
 * SSRF guard instead (#733). The control window does not opt in: it renders no
 * iframe today, and relaxing it would leave `control.html`'s `<meta>` CSP as
 * the only thing standing between a future embed and remote content.
 *
 * `appPageURL` and `openExternal` are injected rather than imported so the
 * guards stay testable without a running Electron app; callers pass
 * `rendererPageURL(...)` and `shell.openExternal`.
 */
export function secureAppWindow(
  webContents: WebContents,
  {
    appPageURL,
    openExternal,
    allowSubframeNavigation = false,
  }: {
    appPageURL: () => string
    openExternal: ((url: string) => void) | null
    allowSubframeNavigation?: boolean
  },
): void {
  webContents.setWindowOpenHandler(({ url }) => {
    // A renderer-opened window is an explicit "take me there" gesture, so it is
    // honoured in the OS browser, where the page gets none of the app's
    // privileges. Anything the OS browser has no business launching -- and the
    // app's own page, which would just be a second copy of the UI -- is dropped
    // with a breadcrumb rather than silently swallowed.
    if (openExternal && url !== appPageURL() && isExternallyOpenable(url)) {
      // Logged because this is the one thing here that reaches outside the app:
      // an operator wondering why their browser just opened something can
      // correlate it.
      log.info('Opening link in the OS browser:', redactURL(url))
      openExternal(url)
    } else {
      log.info(
        'Denied window open without handing it to the OS browser:',
        redactURL(url),
      )
    }
    return { action: 'deny' as const }
  })

  // A navigation is only ever cancelled, never redirected outward: unlike a
  // window open it need not come from a click at all (a 302, a `<meta
  // http-equiv="refresh">`, a dropped URL), and those must not be able to launch
  // the operator's browser at a control-server-supplied address unattended.
  const guard = (event: NavigationEvent) => {
    // Where the caller hosts third-party iframes, a sub-frame navigating itself
    // is not this window leaving its page. An event that reports no frame at
    // all is treated as the main frame, so an unknown event shape fails closed.
    if (allowSubframeNavigation && event.isMainFrame === false) {
      return
    }
    if (event.url === appPageURL() || event.url === webContents.getURL()) {
      return
    }
    log.info(
      'Blocking navigation away from the app page:',
      redactURL(event.url),
    )
    event.preventDefault()
  }
  webContents.on('will-navigate', guard)
  webContents.on('will-redirect', guard)
}
