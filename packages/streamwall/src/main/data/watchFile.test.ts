import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { StreamDataContent } from 'streamwall-shared'
import { describe, expect, test, vi } from 'vitest'
import log from '../logger'
import { waitForListener } from './testHelpers'
import { watchDataFile } from './watchFile'

class FakeWatcher extends EventEmitter {
  close = vi.fn(async () => {})
}

let fakeWatcher: FakeWatcher | undefined

vi.mock('chokidar', () => ({
  watch: vi.fn(() => {
    fakeWatcher = new FakeWatcher()
    return fakeWatcher
  }),
}))

function writeTomlFile(contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sw-data-'))
  const file = path.join(dir, 'streams.toml')
  writeFileSync(file, contents)
  return file
}

describe('watchDataFile', () => {
  test('keeps valid entries and skips invalid ones', async () => {
    const file = writeTomlFile(`
[[streams]]
link = "https://a.example/s"
kind = "video"

[[streams]]
kind = "audio"

[[streams]]
link = "https://c.example/s"
`)
    const gen = watchDataFile(file)
    try {
      const { value } = await gen.next()
      expect(value?.map((s: StreamDataContent) => s.link)).toEqual([
        'https://a.example/s',
        'https://c.example/s',
      ])
    } finally {
      await gen.return(undefined)
    }
  })

  test('strips injected internal identity fields', async () => {
    const file = writeTomlFile(`
[[streams]]
link = "https://a.example/s"
_id = "injected"
_dataSource = "attacker"
`)
    const gen = watchDataFile(file)
    try {
      const { value } = await gen.next()
      expect(value).toHaveLength(1)
      expect(value?.[0]).not.toHaveProperty('_id')
      expect(value?.[0]).not.toHaveProperty('_dataSource')
    } finally {
      await gen.return(undefined)
    }
  })

  test('yields an empty list when streams is not an array', async () => {
    const file = writeTomlFile('streams = "not an array"\n')
    const gen = watchDataFile(file)
    try {
      const { value } = await gen.next()
      expect(value).toEqual([])
    } finally {
      await gen.return(undefined)
    }
  })

  test('re-reads on an unlink+add cycle instead of only on change', async () => {
    const file = writeTomlFile(`
[[streams]]
link = "https://a.example/s"
`)
    const gen = watchDataFile(file)
    try {
      const first = await gen.next()
      expect(first.value?.map((s: StreamDataContent) => s.link)).toEqual([
        'https://a.example/s',
      ])

      writeFileSync(
        file,
        `
[[streams]]
link = "https://b.example/s"
`,
      )
      const watcher = fakeWatcher!
      const next = gen.next()
      await waitForListener(watcher, 'all')
      // Simulate an atomic replace that chokidar reports as unlink+add
      // rather than a single 'change' event.
      watcher.emit('all', 'unlink', file)
      watcher.emit('all', 'add', file)
      const second = await next
      expect(second.value?.map((s: StreamDataContent) => s.link)).toEqual([
        'https://b.example/s',
      ])
    } finally {
      await gen.return(undefined)
    }
  })

  test('does not crash and keeps watching after a watcher error', async () => {
    const file = writeTomlFile(`
[[streams]]
link = "https://a.example/s"
`)
    const gen = watchDataFile(file)
    try {
      await gen.next()
      const watcher = fakeWatcher!

      const next = gen.next()
      await waitForListener(watcher, 'all')
      watcher.emit('error', new Error('EPERM'))
      writeFileSync(
        file,
        `
[[streams]]
link = "https://b.example/s"
`,
      )
      watcher.emit('all', 'change', file)
      const { value } = await next
      expect(value?.map((s: StreamDataContent) => s.link)).toEqual([
        'https://b.example/s',
      ])
    } finally {
      await gen.return(undefined)
    }
  })

  test('logs a watcher error exactly once', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const file = writeTomlFile(`
[[streams]]
link = "https://a.example/s"
`)
    const gen = watchDataFile(file)
    try {
      await gen.next()
      const watcher = fakeWatcher!

      const next = gen.next()
      await waitForListener(watcher, 'all')
      // Both the permanent 'error' listener and the `once(watcher, 'all')`
      // race promise observe this emission; only one of them may log it.
      watcher.emit('error', new Error('EPERM'))
      watcher.emit('all', 'change', file)
      await next

      expect(
        warnSpy.mock.calls.filter(
          ([message]) => message === 'error watching data file',
        ),
      ).toHaveLength(1)
    } finally {
      await gen.return(undefined)
      warnSpy.mockRestore()
    }
  })

  test('keeps the last known-good streams when a read fails after a successful read', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sw-data-'))
    const file = path.join(dir, 'streams.toml')
    writeFileSync(
      file,
      `
[[streams]]
link = "https://a.example/s"
`,
    )
    const gen = watchDataFile(file)
    try {
      const first = await gen.next()
      expect(first.value?.map((s: StreamDataContent) => s.link)).toEqual([
        'https://a.example/s',
      ])

      // Delete the file so the next read fails, then notify the watcher.
      // A single outstanding next() call spans both the failed re-read
      // (which must not surface an empty/wiped list) and the eventual
      // successful re-read below.
      rmSync(file)
      const watcher = fakeWatcher!
      const pendingNext = gen.next()
      await waitForListener(watcher, 'all')
      watcher.emit('all', 'unlink', file)

      // The failed re-read must not surface a wiped-out empty list:
      // pendingNext should still be unresolved at this point.
      const stillPending = Symbol('pending')
      const raceResult = await Promise.race([
        pendingNext,
        new Promise((resolve) => setTimeout(() => resolve(stillPending), 50)),
      ])
      expect(raceResult).toBe(stillPending)

      writeFileSync(
        file,
        `
[[streams]]
link = "https://b.example/s"
`,
      )
      await waitForListener(watcher, 'all')
      watcher.emit('all', 'add', file)

      const second = await pendingNext
      expect(second.value?.map((s: StreamDataContent) => s.link)).toEqual([
        'https://b.example/s',
      ])
    } finally {
      await gen.return(undefined)
    }
  })

  test('reports healthy status on a successful read', async () => {
    const file = writeTomlFile(`
[[streams]]
link = "https://a.example/s"
`)
    const onHealth = vi.fn()
    const gen = watchDataFile(file, onHealth)
    try {
      await gen.next()
      expect(onHealth).toHaveBeenCalledWith(true)
    } finally {
      await gen.return(undefined)
    }
  })

  test('reports unhealthy status with a message when the file cannot be read', async () => {
    const missingFile = path.join(
      mkdtempSync(path.join(tmpdir(), 'sw-data-')),
      'does-not-exist.toml',
    )
    const onHealth = vi.fn()
    const gen = watchDataFile(missingFile, onHealth)
    try {
      await gen.next()
      expect(onHealth).toHaveBeenCalledWith(false, expect.any(String))
    } finally {
      await gen.return(undefined)
    }
  })

  // Regression test for #339: once a value has been yielded, the generator
  // suspends waiting for the *next* filesystem event, which may never come.
  // A plain `await once(watcher, 'all')` there would queue an early
  // `.return()` behind that pending wait per the async generator spec,
  // hanging teardown forever (see the investigation notes in #337).
  test('return() resolves immediately while an event-wait is in flight, even though no event ever fires', async () => {
    const file = writeTomlFile(`
[[streams]]
link = "https://a.example/s"
`)
    const gen = watchDataFile(file)
    await gen.next()

    // A second, unawaited next() resumes the generator past the yield and
    // into the wait for the next filesystem event, leaving that next()
    // call permanently in flight since no event is ever emitted below.
    const pendingNext = gen.next()
    pendingNext.catch(() => {})
    await waitForListener(fakeWatcher!, 'all')

    // No filesystem event is ever emitted here: the fix must settle
    // return() without waiting on one.
    await expect(
      Promise.race([
        gen.return(undefined),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('return() hung')), 500),
        ),
      ]),
    ).resolves.toBeDefined()
  })
})
