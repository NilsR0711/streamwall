import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { StreamDataContent } from 'streamwall-shared'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { pollDataURL, watchDataFile } from './data'

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

// Async generator resumption (and therefore listener registration inside
// the generator body) is not synchronous with the .next() call that
// triggers it, so tests poll for the listener rather than emitting
// immediately after calling next().
async function waitForListener(
  emitter: EventEmitter,
  event: string,
): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (emitter.listenerCount(event) > 0) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`listener for "${event}" was not registered in time`)
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
})

describe('pollDataURL', () => {
  let server: Server | undefined

  afterEach(() => {
    server?.close()
    server = undefined
  })

  async function serveJson(body: unknown): Promise<string> {
    server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(body))
    })
    await new Promise<void>((resolve) =>
      server!.listen(0, '127.0.0.1', resolve),
    )
    const { port } = server.address() as AddressInfo
    return `http://127.0.0.1:${port}/`
  }

  test('keeps valid entries and skips invalid ones from a JSON body', async () => {
    const url = await serveJson([
      { link: 'https://a.example/s', kind: 'video' },
      { kind: 'audio' },
      { link: 'https://b.example/s', _id: 'injected' },
    ])
    const gen = pollDataURL(url, 999)
    try {
      const { value } = await gen.next()
      expect(value?.map((s: StreamDataContent) => s.link)).toEqual([
        'https://a.example/s',
        'https://b.example/s',
      ])
      expect(value?.[1]).not.toHaveProperty('_id')
    } finally {
      await gen.return(undefined)
    }
  })

  test('yields an empty list when the JSON body is not an array', async () => {
    const url = await serveJson({ not: 'an array' })
    const gen = pollDataURL(url, 999)
    try {
      const { value } = await gen.next()
      expect(value).toEqual([])
    } finally {
      await gen.return(undefined)
    }
  })

  test('reports healthy status on a successful fetch', async () => {
    const url = await serveJson([{ link: 'https://a.example/s' }])
    const onHealth = vi.fn()
    const gen = pollDataURL(url, 999, onHealth)
    try {
      await gen.next()
      expect(onHealth).toHaveBeenCalledWith(true)
    } finally {
      await gen.return(undefined)
    }
  })

  test('reports unhealthy status with a message when the fetch fails', async () => {
    const onHealth = vi.fn()
    // Nothing is listening on this port.
    const gen = pollDataURL('http://127.0.0.1:1/', 999, onHealth)
    try {
      await gen.next()
      expect(onHealth).toHaveBeenCalledWith(false, expect.any(String))
    } finally {
      await gen.return(undefined)
    }
  })
})
