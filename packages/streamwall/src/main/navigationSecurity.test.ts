import assert from 'node:assert/strict'
import { test, vi } from 'vitest'

import type { WebContents } from 'electron'

import { denyWindowOpen, secureStreamView } from './navigationSecurity'

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
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
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
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  const wc = new FakeWebContents('https://example.com/stream')
  secureStreamView(asWebContents(wc))

  assert.equal(
    wc.dispatchNavigation('will-redirect', 'https://example.com/stream'),
    false,
  )
})
