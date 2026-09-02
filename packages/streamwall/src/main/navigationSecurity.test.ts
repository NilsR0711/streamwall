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
// survive a navigation (#732).
const APP_PAGE = 'file:///app/renderer/control.html'

test('secureAppWindow hands an http(s) popup to the OS browser and denies the in-app window', () => {
  const wc = new FakeWebContents(APP_PAGE)
  const openExternal = vi.fn()
  secureAppWindow(asWebContents(wc), openExternal)

  assert.ok(wc.windowOpenHandler, 'a window-open handler must be registered')
  assert.deepEqual(
    wc.windowOpenHandler({ url: 'https://example.com/stream' }),
    {
      action: 'deny',
    },
  )
  assert.deepEqual(openExternal.mock.calls, [['https://example.com/stream']])
})

test('secureAppWindow denies a non-http popup without handing it to the OS', () => {
  const wc = new FakeWebContents(APP_PAGE)
  const openExternal = vi.fn()
  secureAppWindow(asWebContents(wc), openExternal)

  assert.deepEqual(wc.windowOpenHandler!({ url: 'file:///etc/passwd' }), {
    action: 'deny',
  })
  assert.equal(openExternal.mock.calls.length, 0)
})

test('secureAppWindow denies a popup whose URL does not parse', () => {
  const wc = new FakeWebContents(APP_PAGE)
  const openExternal = vi.fn()
  secureAppWindow(asWebContents(wc), openExternal)

  assert.deepEqual(wc.windowOpenHandler!({ url: 'not a url' }), {
    action: 'deny',
  })
  assert.equal(openExternal.mock.calls.length, 0)
})

test('secureAppWindow blocks will-navigate away and opens the target externally', () => {
  const wc = new FakeWebContents(APP_PAGE)
  const openExternal = vi.fn()
  secureAppWindow(asWebContents(wc), openExternal)

  assert.equal(
    wc.dispatchNavigation('will-navigate', 'https://evil.example/'),
    true,
  )
  assert.deepEqual(openExternal.mock.calls, [['https://evil.example/']])
})

test('secureAppWindow blocks a will-redirect escape once the app page has committed', () => {
  const wc = new FakeWebContents(APP_PAGE)
  const openExternal = vi.fn()
  secureAppWindow(asWebContents(wc), openExternal)

  assert.equal(
    wc.dispatchNavigation('will-redirect', 'https://evil.example/'),
    true,
  )
})

test('secureAppWindow blocks a non-http navigation without handing it to the OS', () => {
  const wc = new FakeWebContents(APP_PAGE)
  const openExternal = vi.fn()
  secureAppWindow(asWebContents(wc), openExternal)

  assert.equal(
    wc.dispatchNavigation('will-navigate', 'file:///etc/passwd'),
    true,
  )
  assert.equal(openExternal.mock.calls.length, 0)
})

test('secureAppWindow allows the app page to reload itself', () => {
  // Silence the informational reload log so test output stays clean.
  vi.spyOn(log, 'info').mockImplementation(() => undefined)
  const wc = new FakeWebContents(APP_PAGE)
  const openExternal = vi.fn()
  secureAppWindow(asWebContents(wc), openExternal)

  assert.equal(wc.dispatchNavigation('will-navigate', APP_PAGE), false)
  assert.equal(openExternal.mock.calls.length, 0)
})

test('secureAppWindow allows the initial load to resolve before anything has committed', () => {
  const wc = new FakeWebContents('')
  const openExternal = vi.fn()
  secureAppWindow(asWebContents(wc), openExternal)

  assert.equal(
    wc.dispatchNavigation(
      'will-redirect',
      'http://localhost:5173/control.html',
    ),
    false,
  )
  assert.equal(openExternal.mock.calls.length, 0)
})
