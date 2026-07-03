import assert from 'node:assert/strict'
import test from 'node:test'
import { QUIT_ACCELERATOR, setupQuitShortcut } from './quitShortcut.ts'

type Handler = (...args: unknown[]) => void

function createHarness() {
  const handlers: Record<string, Handler[]> = {}
  const registered = new Map<string, () => void>()
  let quitCalls = 0
  let registerCalls = 0
  let unregisterCalls = 0
  let focused: object | null = null

  const app = {
    on(event: string, cb: Handler) {
      ;(handlers[event] ??= []).push(cb)
      return app
    },
    quit() {
      quitCalls++
    },
  }

  const globalShortcut = {
    register(accelerator: string, cb: () => void) {
      registerCalls++
      registered.set(accelerator, cb)
      return true
    },
    unregister(accelerator: string) {
      unregisterCalls++
      registered.delete(accelerator)
    },
    isRegistered(accelerator: string) {
      return registered.has(accelerator)
    },
  }

  return {
    app,
    globalShortcut,
    registered,
    emit(event: string, ...args: unknown[]) {
      for (const h of handlers[event] ?? []) {
        h(...args)
      }
    },
    setFocused(win: object | null) {
      focused = win
    },
    // Synchronous defer so blur handling is observable immediately in tests.
    defer(cb: () => void) {
      cb()
    },
    getFocusedWindow: () => focused,
    get quitCalls() {
      return quitCalls
    },
    get registerCalls() {
      return registerCalls
    },
    get unregisterCalls() {
      return unregisterCalls
    },
  }
}

function setup(h: ReturnType<typeof createHarness>) {
  setupQuitShortcut({
    app: h.app,
    globalShortcut: h.globalShortcut,
    getFocusedWindow: h.getFocusedWindow,
    defer: h.defer,
  })
}

test('uses the platform-standard quit accelerator', () => {
  assert.equal(QUIT_ACCELERATOR, 'CommandOrControl+Q')
})

test('registers the quit accelerator when a window gains focus', () => {
  const h = createHarness()
  setup(h)

  h.setFocused({})
  h.emit('browser-window-focus')

  assert.ok(h.registered.has(QUIT_ACCELERATOR))
})

test('the registered accelerator quits the app when triggered', () => {
  const h = createHarness()
  setup(h)

  h.setFocused({})
  h.emit('browser-window-focus')
  h.registered.get(QUIT_ACCELERATOR)?.()

  assert.equal(h.quitCalls, 1)
})

test('does not register twice while already focused', () => {
  const h = createHarness()
  setup(h)

  h.setFocused({})
  h.emit('browser-window-focus')
  h.emit('browser-window-focus')

  assert.equal(h.registerCalls, 1)
})

test('unregisters when the app loses focus entirely', () => {
  const h = createHarness()
  setup(h)

  h.setFocused({})
  h.emit('browser-window-focus')

  h.setFocused(null)
  h.emit('browser-window-blur')

  assert.ok(!h.registered.has(QUIT_ACCELERATOR))
})

test('stays registered while switching between the app own windows', () => {
  const h = createHarness()
  setup(h)

  const streamWindow = {}
  const controlWindow = {}

  h.setFocused(streamWindow)
  h.emit('browser-window-focus')

  // Switching windows blurs the old one while another app window is focused.
  h.setFocused(controlWindow)
  h.emit('browser-window-blur')

  assert.ok(h.registered.has(QUIT_ACCELERATOR))
})

test('registers immediately if a window is already focused at setup', () => {
  const h = createHarness()
  h.setFocused({})

  setup(h)

  assert.ok(h.registered.has(QUIT_ACCELERATOR))
})

test('does not register at setup when no window is focused', () => {
  const h = createHarness()
  setup(h)

  assert.ok(!h.registered.has(QUIT_ACCELERATOR))
})

test('unregisters on will-quit', () => {
  const h = createHarness()
  setup(h)

  h.setFocused({})
  h.emit('browser-window-focus')
  h.emit('will-quit')

  assert.ok(!h.registered.has(QUIT_ACCELERATOR))
})

test('does not attempt to unregister when nothing is registered', () => {
  const h = createHarness()
  setup(h)

  h.setFocused(null)
  h.emit('browser-window-blur')

  assert.equal(h.unregisterCalls, 0)
})
