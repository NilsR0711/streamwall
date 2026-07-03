import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, test } from 'node:test'
import { InteractWindow } from './InteractWindow.ts'

class FakeWindow extends EventEmitter {
  loadedURLs: string[] = []
  titles: string[] = []
  focusCount = 0
  destroyed = false

  loadURL(url: string) {
    this.loadedURLs.push(url)
  }
  setTitle(title: string) {
    this.titles.push(title)
  }
  focus() {
    this.focusCount++
  }
  isDestroyed() {
    return this.destroyed
  }
  destroy() {
    if (!this.destroyed) {
      this.destroyed = true
      this.emit('closed')
    }
  }
  // Simulate the operator closing the window from the UI.
  userClose() {
    this.destroy()
  }
}

function noop() {
  // no-op onApply for tests that do not assert on reloads
}

function setup() {
  const windows: FakeWindow[] = []
  const sessions: unknown[] = []
  const interactWindow = new InteractWindow((session) => {
    sessions.push(session)
    const win = new FakeWindow()
    windows.push(win)
    return win
  })
  return { windows, sessions, interactWindow }
}

describe('InteractWindow', () => {
  test('opens a window bound to the target session and loads url/title', () => {
    const { windows, sessions, interactWindow } = setup()
    const session = { id: 'view-0' }
    let applied = 0

    interactWindow.open(
      { url: 'https://youtube.com/watch?v=x', title: 'Interact: A', session },
      () => applied++,
    )

    assert.equal(windows.length, 1)
    assert.deepEqual(sessions, [session])
    assert.deepEqual(windows[0].loadedURLs, ['https://youtube.com/watch?v=x'])
    assert.deepEqual(windows[0].titles, ['Interact: A'])
    assert.equal(windows[0].focusCount, 1)
    assert.equal(applied, 0)
  })

  test('reuses the window when the same session is targeted again', () => {
    const { windows, interactWindow } = setup()
    const session = { id: 'view-0' }
    let applied = 0

    interactWindow.open(
      { url: 'https://a.example/', title: 'A', session },
      () => applied++,
    )
    interactWindow.open(
      { url: 'https://a.example/live', title: 'A live', session },
      () => applied++,
    )

    assert.equal(windows.length, 1)
    assert.deepEqual(windows[0].loadedURLs, [
      'https://a.example/',
      'https://a.example/live',
    ])
    assert.equal(applied, 0)
  })

  test('replaces the window and reloads the previous view when the session changes', () => {
    const { windows, interactWindow } = setup()
    const sessionA = { id: 'view-0' }
    const sessionB = { id: 'view-1' }
    let appliedA = 0
    let appliedB = 0

    interactWindow.open(
      { url: 'https://a.example/', title: 'A', session: sessionA },
      () => appliedA++,
    )
    interactWindow.open(
      { url: 'https://b.example/', title: 'B', session: sessionB },
      () => appliedB++,
    )

    assert.equal(windows.length, 2)
    assert.equal(windows[0].destroyed, true)
    assert.equal(appliedA, 1)
    assert.equal(appliedB, 0)
  })

  test('reloads the current view when the window is closed by the operator', () => {
    const { windows, interactWindow } = setup()
    const session = { id: 'view-2' }
    let applied = 0

    interactWindow.open(
      { url: 'https://a.example/', title: 'A', session },
      () => applied++,
    )
    windows[0].userClose()

    assert.equal(applied, 1)
  })

  test('applies each view exactly once across a switch and a later close', () => {
    const { windows, interactWindow } = setup()
    const sessionA = { id: 'view-0' }
    const sessionB = { id: 'view-1' }
    let appliedA = 0
    let appliedB = 0

    interactWindow.open(
      { url: 'https://a.example/', title: 'A', session: sessionA },
      () => appliedA++,
    )
    interactWindow.open(
      { url: 'https://b.example/', title: 'B', session: sessionB },
      () => appliedB++,
    )
    windows[1].userClose()

    assert.equal(appliedA, 1)
    assert.equal(appliedB, 1)
  })

  test('opens a fresh window after the previous one was closed', () => {
    const { windows, interactWindow } = setup()
    const session = { id: 'view-0' }

    interactWindow.open(
      { url: 'https://a.example/', title: 'A', session },
      noop,
    )
    windows[0].userClose()
    interactWindow.open(
      { url: 'https://a.example/', title: 'A', session },
      noop,
    )

    assert.equal(windows.length, 2)
  })

  test('does not reload a replaced window again if it emits closed later', () => {
    const { windows, interactWindow } = setup()
    const sessionA = { id: 'view-0' }
    const sessionB = { id: 'view-1' }
    let appliedA = 0

    interactWindow.open(
      { url: 'https://a.example/', title: 'A', session: sessionA },
      () => appliedA++,
    )
    interactWindow.open(
      { url: 'https://b.example/', title: 'B', session: sessionB },
      noop,
    )
    // The already-destroyed window A must not trigger a second reload.
    windows[0].emit('closed')

    assert.equal(appliedA, 1)
  })
})
