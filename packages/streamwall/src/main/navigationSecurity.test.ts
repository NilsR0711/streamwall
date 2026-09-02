import assert from 'node:assert/strict'
import { test, vi } from 'vitest'

import type { WebContents } from 'electron'

import log from './logger'
import {
  denyWindowOpen,
  secureAppWindow,
  secureStreamView,
} from './navigationSecurity'

interface NavEvent {
  url: string
  preventDefault(): void
}

// A hand-rolled stand-in for Electron's WebContents. The real one can only be
// instantiated inside a running Electron app, so the guards are written against
// the narrow surface they use (`on`, `getURL`, `setWindowOpenHandler`) and this
// double records what they wire up.
class FakeWebContents {
  url: string
  windowOpenHandler: ((details?: unknown) => { action: string }) | null = null
  navHandlers: Record<string, Array<(event: NavEvent) => void>> = {}

  constructor(url: string) {
    this.url = url
  }

  getURL(): string {
    return this.url
  }

  on(event: string, listener: (event: NavEvent) => void): this {
    const handlers = this.navHandlers[event] ?? []
    handlers.push(listener)
    this.navHandlers[event] = handlers
    return this
  }

  setWindowOpenHandler(
    handler: (details?: unknown) => { action: string },
  ): void {
    this.windowOpenHandler = handler
  }

  // Dispatch a navigation event to the registered listeners and report whether
  // any of them called preventDefault().
  dispatchNavigation(event: string, url: string): boolean {
    let prevented = false
    const navEvent: NavEvent = {
      url,
      preventDefault: () => {
        prevented = true
      },
    }
    for (const listener of this.navHandlers[event] ?? []) {
      listener(navEvent)
    }
    return prevented
  }
}

const asWebContents = (fake: FakeWebContents) => fake as unknown as WebContents

test('denyWindowOpen installs a handler that denies every popup', () => {
  const wc = new FakeWebContents('https://example.com/stream')
  denyWindowOpen(asWebContents(wc))

  assert.ok(wc.windowOpenHandler, 'a window-open handler must be registered')
  assert.deepEqual(wc.windowOpenHandler({ url: 'https://evil.example/' }), {
    action: 'deny',
  })
})

test('secureStreamView denies window.open popups', () => {
  const wc = new FakeWebContents('https://example.com/stream')
  secureStreamView(asWebContents(wc))

  assert.ok(wc.windowOpenHandler, 'a window-open handler must be registered')
  assert.deepEqual(wc.windowOpenHandler({ url: 'https://evil.example/' }), {
    action: 'deny',
  })
})

test('secureStreamView blocks will-navigate to a different URL', () => {
  const wc = new FakeWebContents('https://example.com/stream')
  secureStreamView(asWebContents(wc))

  assert.equal(
    wc.dispatchNavigation('will-navigate', 'https://evil.example/'),
    true,
  )
})

test('secureStreamView allows will-navigate to the same URL (self reload)', () => {
  // Silence the informational reload log so test output stays clean.
  vi.spyOn(log, 'info').mockImplementation(() => undefined)
  const wc = new FakeWebContents('https://example.com/stream')
  secureStreamView(asWebContents(wc))

  assert.equal(
    wc.dispatchNavigation('will-navigate', 'https://example.com/stream'),
    false,
  )
})

test("secureStreamView keeps a stream URL's signed-token query out of the reload log", () => {
  // Stream and CDN URLs routinely carry a signed token, and the file log
  // transport persists everything from `info` down.
  const info = vi.spyOn(log, 'info').mockImplementation(() => undefined)
  const streamURL = 'https://cdn.example/live.m3u8?token=secret-token'
  const wc = new FakeWebContents(streamURL)
  secureStreamView(asWebContents(wc))

  wc.dispatchNavigation('will-navigate', streamURL)

  const logged = info.mock.calls.map((args) => args.join(' ')).join('\n')
  assert.doesNotMatch(logged, /secret-token/)
  assert.match(logged, /https:\/\/cdn\.example\/live\.m3u8/)
})

test('secureStreamView blocks a redirect away once a page has committed (302 escape)', () => {
  const wc = new FakeWebContents('https://example.com/stream')
  secureStreamView(asWebContents(wc))

  assert.equal(
    wc.dispatchNavigation('will-redirect', 'https://evil.example/'),
    true,
  )
})

test('secureStreamView allows a redirect while the initial load is still resolving', () => {
  // A fresh view has committed nothing yet, so getURL() is empty. The
  // operator-supplied URL's own server redirects (http->https, CDN, shortlinks)
  // fire `will-redirect` even though the load was started from the main process
  // and must be allowed to resolve.
  const wc = new FakeWebContents('')
  secureStreamView(asWebContents(wc))

  assert.equal(
    wc.dispatchNavigation('will-redirect', 'https://cdn.example/live'),
    false,
  )
})

test('secureStreamView allows will-redirect to the same URL', () => {
  // Silence the informational reload log so test output stays clean.
  vi.spyOn(log, 'info').mockImplementation(() => undefined)
  const wc = new FakeWebContents('https://example.com/stream')
  secureStreamView(asWebContents(wc))

  assert.equal(
    wc.dispatchNavigation('will-redirect', 'https://example.com/stream'),
    false,
  )
})

// The control window renders the app's own bundled UI and holds the
// `streamwallControl` bridge, so it must never be allowed to navigate to remote
// content: the `control:*` sender guards compare against the same webContents
// and would keep passing afterwards, and control.html's <meta> CSP does not
// survive a navigation (#732). Unlike a stream view it is pinned to a named
// page rather than to whatever committed, so there is no window in which
// anything goes -- and to one page rather than the whole renderer bundle, whose
// other pages carry weaker CSPs.
const APP_PAGE = 'file:///app/renderer/main_window/src/renderer/control.html'
const OTHER_APP_PAGE =
  'file:///app/renderer/main_window/src/renderer/overlay.html'

// Builds a control-window-style guard set over a fake webContents, returning
// the double, the injected `openExternal` spy, and the guard's log output.
function secureFakeAppWindow(currentURL = APP_PAGE) {
  // Captured rather than printed, so the breadcrumbs can be asserted on without
  // spamming test output.
  const info = vi.spyOn(log, 'info').mockImplementation(() => undefined)
  const wc = new FakeWebContents(currentURL)
  const openExternal = vi.fn()
  secureAppWindow(asWebContents(wc), {
    appPageURL: () => APP_PAGE,
    openExternal,
  })
  const logged = () => info.mock.calls.map((args) => args.join(' ')).join('\n')
  return { wc, openExternal, logged }
}

test('secureAppWindow hands an http(s) popup to the OS browser and denies the in-app window', () => {
  const { wc, openExternal } = secureFakeAppWindow()

  assert.ok(wc.windowOpenHandler, 'a window-open handler must be registered')
  assert.deepEqual(
    wc.windowOpenHandler({ url: 'https://example.com/stream' }),
    {
      action: 'deny',
    },
  )
  assert.deepEqual(openExternal.mock.calls, [['https://example.com/stream']])
})

test('secureAppWindow records the external open, without the credentials a link may carry', () => {
  // The file log transport persists everything from `info` down, and the
  // control UI renders links whose secret lives in the fragment (invite links).
  const { wc, logged } = secureFakeAppWindow()

  wc.windowOpenHandler!({
    url: 'https://example.com/invite?key=secret-query#token=secret-fragment',
  })

  assert.match(logged(), /Opening link in the OS browser/)
  assert.match(logged(), /https:\/\/example\.com\/invite/)
  assert.doesNotMatch(logged(), /secret-query|secret-fragment/)
})

test('secureAppWindow keeps credentials out of the log when it denies a link too', () => {
  const { wc, logged } = secureFakeAppWindow()

  wc.windowOpenHandler!({ url: `${APP_PAGE}#token=secret-fragment` })

  assert.doesNotMatch(logged(), /secret-fragment/)
})

test('secureAppWindow logs nothing but the scheme of an opaque-path URL', () => {
  // data:, javascript:, mailto: and friends put their whole payload in the
  // path, so there is no "where it points" to keep.
  const { wc, logged } = secureFakeAppWindow()

  wc.windowOpenHandler!({ url: 'data:text/html,<h1>secret-payload</h1>' })
  wc.windowOpenHandler!({ url: 'javascript:alert(document.cookie)' })

  assert.doesNotMatch(logged(), /secret-payload|document\.cookie/)
  assert.match(logged(), /data:<opaque>/)
  assert.match(logged(), /javascript:<opaque>/)
})

test('secureAppWindow logs no userinfo credentials', () => {
  const { wc, logged } = secureFakeAppWindow()

  wc.windowOpenHandler!({ url: 'https://user:secret-password@example.com/x' })

  assert.doesNotMatch(logged(), /secret-password/)
  assert.match(logged(), /https:\/\/example\.com\/x/)
})

test('secureAppWindow keeps credentials out of the log when it blocks a navigation', () => {
  const { wc, logged } = secureFakeAppWindow()

  wc.dispatchNavigation('will-navigate', 'https://evil.example/#token=secret')

  assert.match(logged(), /Blocking navigation away from the app page/)
  assert.doesNotMatch(logged(), /secret/)
})

test('secureAppWindow denies a non-http popup without handing it to the OS', () => {
  const { wc, openExternal } = secureFakeAppWindow()

  assert.deepEqual(wc.windowOpenHandler!({ url: 'file:///etc/passwd' }), {
    action: 'deny',
  })
  assert.equal(openExternal.mock.calls.length, 0)
})

test('secureAppWindow denies a popup whose URL does not parse', () => {
  const { wc, openExternal } = secureFakeAppWindow()

  assert.deepEqual(wc.windowOpenHandler!({ url: 'not a url' }), {
    action: 'deny',
  })
  assert.equal(openExternal.mock.calls.length, 0)
})

test('secureAppWindow denies a popup onto the app itself without launching a browser copy of the UI', () => {
  const { wc, openExternal } = secureFakeAppWindow()

  assert.deepEqual(wc.windowOpenHandler!({ url: APP_PAGE }), {
    action: 'deny',
  })
  assert.equal(openExternal.mock.calls.length, 0)
})

test('secureAppWindow cancels a navigation away without launching the browser unattended', () => {
  // A navigation need not come from a click -- a 302 or a meta refresh reaches
  // here too -- so it is only ever cancelled, never forwarded outward.
  const { wc, openExternal } = secureFakeAppWindow()

  assert.equal(
    wc.dispatchNavigation('will-navigate', 'https://evil.example/'),
    true,
  )
  assert.equal(openExternal.mock.calls.length, 0)
})

test('secureAppWindow blocks a will-redirect escape too, so a 302 cannot do what a click cannot', () => {
  const { wc } = secureFakeAppWindow()

  assert.equal(
    wc.dispatchNavigation('will-redirect', 'https://evil.example/'),
    true,
  )
})

test('secureAppWindow blocks a non-http navigation', () => {
  const { wc, openExternal } = secureFakeAppWindow()

  assert.equal(
    wc.dispatchNavigation('will-navigate', 'file:///etc/passwd'),
    true,
  )
  assert.equal(openExternal.mock.calls.length, 0)
})

test('secureAppWindow blocks a navigation to a different page of the same bundle', () => {
  // The layer and HLS pages carry weaker CSPs than the control page, and this
  // webContents keeps its preload across such a navigation.
  const { wc } = secureFakeAppWindow()

  assert.equal(wc.dispatchNavigation('will-navigate', OTHER_APP_PAGE), true)
})

test('secureAppWindow allows the app page to reload itself', () => {
  const { wc, openExternal } = secureFakeAppWindow()

  assert.equal(wc.dispatchNavigation('will-navigate', APP_PAGE), false)
  assert.equal(openExternal.mock.calls.length, 0)
})

test('secureAppWindow allows a reload spelled the way the window committed it', () => {
  // Electron may spell the loaded file: URL slightly differently than
  // `appPageURL` does; the committed URL can only ever be an app page, since
  // nothing else is allowed to commit.
  const committed = `${APP_PAGE}?v=1`
  const { wc } = secureFakeAppWindow(committed)

  assert.equal(wc.dispatchNavigation('will-navigate', committed), false)
})

test('secureAppWindow blocks a remote navigation even before anything has committed', () => {
  // Unlike a stream view, an app window's page is loaded from disk by the main
  // process: there is no operator-supplied redirect chain to leave room for, so
  // an uncommitted window must not be a hole.
  const { wc } = secureFakeAppWindow('')

  assert.equal(
    wc.dispatchNavigation('will-redirect', 'https://evil.example/'),
    true,
  )
})
