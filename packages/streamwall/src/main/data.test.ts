import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { StreamDataContent } from 'streamwall-shared'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  combineDataSources,
  LocalStreamData,
  markDataSource,
  pollDataURL,
  presetDataSource,
  StreamIDGenerator,
  watchDataFile,
} from './data'
import type { PresetPack } from './presets'

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

  test('retains the last successful batch and keeps polling after an empty response', async () => {
    let body: unknown[] = [{ link: 'https://a.example/s', kind: 'video' }]
    server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(body))
    })
    await new Promise<void>((resolve) =>
      server!.listen(0, '127.0.0.1', resolve),
    )
    const { port } = server.address() as AddressInfo
    const url = `http://127.0.0.1:${port}/`

    const gen = pollDataURL(url, 0.1)
    try {
      const first = await gen.next()
      expect(first.value?.map((s: StreamDataContent) => s.link)).toEqual([
        'https://a.example/s',
      ])

      // The endpoint now returns no streams. The cached batch must not be
      // surfaced as wiped out; the outstanding next() should still be
      // unresolved while polling continues in the background.
      body = []
      const pending = gen.next()

      const stillPending = Symbol('pending')
      const raceResult = await Promise.race([
        pending,
        new Promise((resolve) => setTimeout(() => resolve(stillPending), 150)),
      ])
      expect(raceResult).toBe(stillPending)

      body = [{ link: 'https://b.example/s', kind: 'video' }]
      const second = await pending
      expect(second.value?.map((s: StreamDataContent) => s.link)).toEqual([
        'https://b.example/s',
      ])
    } finally {
      await gen.return(undefined)
    }
  })
})

describe('StreamIDGenerator', () => {
  function stream(
    overrides: Partial<StreamDataContent> & { link: string },
  ): StreamDataContent {
    return { kind: 'video', ...overrides }
  }

  test('derives a 3-character id from the source/label/link', () => {
    const gen = new StreamIDGenerator()
    const streams = [
      stream({ link: 'https://a.example/s', source: 'Example Source' }),
    ]
    gen.process(streams)
    expect(streams[0]._id).toBe('exa')
  })

  test('resolves collisions with an incrementing numeric suffix', () => {
    const gen = new StreamIDGenerator()
    const streams = [
      stream({ link: 'https://a.example/s', source: 'Example' }),
      stream({ link: 'https://b.example/s', source: 'Example' }),
      stream({ link: 'https://c.example/s', source: 'Example' }),
    ]
    gen.process(streams)
    expect(streams.map((s) => s._id)).toEqual(['exa', 'exa1', 'exa2'])
  })

  test('strips a leading "the" prefix before deriving the id', () => {
    const gen = new StreamIDGenerator()
    const streams = [
      stream({ link: 'https://a.example/s', source: 'The Stream' }),
    ]
    gen.process(streams)
    expect(streams[0]._id).toBe('str')
  })

  test('strips a leading http(s)/www prefix before deriving the id', () => {
    const gen = new StreamIDGenerator()
    const streams = [
      stream({
        link: 'https://ignored.example/s',
        source: 'http://www.Example.com',
      }),
    ]
    gen.process(streams)
    expect(streams[0]._id).toBe('exa')
  })

  test('skips a stream with no usable id base and leaves it without an id', () => {
    const gen = new StreamIDGenerator()
    const streams = [stream({ link: '' })]
    gen.process(streams)
    expect(streams[0]._id).toBeUndefined()
  })

  test('keeps a stable id for the same link across repeated process() calls', () => {
    const gen = new StreamIDGenerator()
    const first = [stream({ link: 'https://a.example/s', source: 'Example' })]
    gen.process(first)
    expect(first[0]._id).toBe('exa')

    const second = [
      stream({ link: 'https://a.example/s', source: 'Example' }),
      stream({ link: 'https://b.example/s', source: 'Example' }),
    ]
    gen.process(second)
    expect(second[0]._id).toBe('exa')
    expect(second[1]._id).toBe('exa1')
  })
})

describe('LocalStreamData', () => {
  test('indexes entries by link and drops entries without a link', () => {
    const data = new LocalStreamData([
      { kind: 'video', link: 'https://a.example/s' },
      { kind: 'video', link: '' },
    ])
    expect([...data.dataByURL.keys()]).toEqual(['https://a.example/s'])
  })

  test('update() defaults kind to "video" for a brand new entry', () => {
    const data = new LocalStreamData()
    data.update('https://a.example/s', {})
    expect(data.dataByURL.get('https://a.example/s')).toMatchObject({
      kind: 'video',
      link: 'https://a.example/s',
    })
  })

  test('update() preserves the existing kind when not overridden', () => {
    const data = new LocalStreamData([
      { kind: 'audio', link: 'https://a.example/s' },
    ])
    data.update('https://a.example/s', { label: 'Renamed' })
    expect(data.dataByURL.get('https://a.example/s')).toMatchObject({
      kind: 'audio',
      label: 'Renamed',
    })
  })

  // Only the Map key move is asserted here: the stored entry's own `.link`
  // field is left stale (the old url) after a rekey, tracked as a separate
  // bug in issue #274.
  test('update() rekeys the entry when data.link differs from the lookup url', () => {
    const data = new LocalStreamData([
      { kind: 'video', link: 'https://a.example/s' },
    ])
    data.update('https://a.example/s', { link: 'https://b.example/s' })
    expect(data.dataByURL.has('https://a.example/s')).toBe(false)
    expect(data.dataByURL.has('https://b.example/s')).toBe(true)
  })

  test('update() stores the new link on the entry itself after rekeying', () => {
    const data = new LocalStreamData([
      { kind: 'video', link: 'https://a.example/s' },
    ])
    data.update('https://a.example/s', { link: 'https://b.example/s' })
    expect(data.dataByURL.get('https://b.example/s')?.link).toBe(
      'https://b.example/s',
    )
  })

  test('update() emits the full entry list on the "update" event', () => {
    const data = new LocalStreamData()
    const onUpdate = vi.fn()
    data.on('update', onUpdate)
    data.update('https://a.example/s', { kind: 'video' })
    expect(onUpdate).toHaveBeenCalledWith([
      expect.objectContaining({ link: 'https://a.example/s' }),
    ])
  })

  test('delete() removes the entry and emits the update event', () => {
    const data = new LocalStreamData([
      { kind: 'video', link: 'https://a.example/s' },
    ])
    const onUpdate = vi.fn()
    data.on('update', onUpdate)
    data.delete('https://a.example/s')
    expect(data.dataByURL.has('https://a.example/s')).toBe(false)
    expect(onUpdate).toHaveBeenCalledWith([])
  })

  test('gen() yields the current snapshot immediately and again after an update', async () => {
    const data = new LocalStreamData([
      { kind: 'video', link: 'https://a.example/s' },
    ])
    const iterator = data.gen()
    try {
      const first = await iterator.next()
      expect(first.value?.map((s) => s.link)).toEqual(['https://a.example/s'])

      // Starting the next pull is what lets the generator's buffered push()
      // resolve and reach the `this.on('update', push)` line (the Repeater's
      // zero-capacity buffer only frees up once a subsequent pull begins).
      const pending = iterator.next()
      await waitForListener(data, 'update')
      data.update('https://b.example/s', { kind: 'video' })
      const second = await pending
      expect(second.value?.map((s) => s.link)).toEqual([
        'https://a.example/s',
        'https://b.example/s',
      ])
    } finally {
      await iterator.return?.(undefined)
    }
  })
})

describe('combineDataSources', () => {
  test('merges entries from multiple sources by link, letting later sources override fields', async () => {
    async function* sourceA() {
      yield [{ kind: 'video', link: 'https://a.example/s', label: 'From A' }]
    }
    async function* sourceB() {
      yield [
        {
          kind: 'video',
          link: 'https://a.example/s',
          label: 'From B',
          notes: 'extra',
        },
      ]
    }
    const gen = combineDataSources(
      [sourceA(), sourceB()],
      new StreamIDGenerator(),
    )
    try {
      const { value } = await gen.next()
      expect(value).toHaveLength(1)
      expect(value?.[0]).toMatchObject({
        link: 'https://a.example/s',
        label: 'From B',
        notes: 'extra',
      })
    } finally {
      await gen.return?.(undefined)
    }
  })

  test('attaches a byURL index to the yielded list for quick lookups', async () => {
    async function* sourceA() {
      yield [{ kind: 'video', link: 'https://a.example/s' }]
    }
    const gen = combineDataSources([sourceA()], new StreamIDGenerator())
    try {
      const { value } = await gen.next()
      expect(value?.byURL?.get('https://a.example/s')).toMatchObject({
        link: 'https://a.example/s',
      })
    } finally {
      await gen.return?.(undefined)
    }
  })

  test('assigns stream ids via the provided StreamIDGenerator', async () => {
    async function* sourceA() {
      yield [{ kind: 'video', link: 'https://a.example/s', source: 'Example' }]
    }
    const gen = combineDataSources([sourceA()], new StreamIDGenerator())
    try {
      const { value } = await gen.next()
      expect(value?.[0]._id).toBe('exa')
    } finally {
      await gen.return?.(undefined)
    }
  })
})

describe('markDataSource', () => {
  test('tags every stream in every yielded batch with the data source name', async () => {
    async function* source() {
      yield [{ kind: 'video', link: 'https://a.example/s' }]
      yield [
        { kind: 'video', link: 'https://a.example/s' },
        { kind: 'video', link: 'https://b.example/s' },
      ]
    }
    const marked = markDataSource(source(), 'my-source')
    try {
      const first = await marked.next()
      expect(
        first.value?.every(
          (s: StreamDataContent) => s._dataSource === 'my-source',
        ),
      ).toBe(true)

      const second = await marked.next()
      expect(
        second.value?.map((s: StreamDataContent) => s._dataSource),
      ).toEqual(['my-source', 'my-source'])
    } finally {
      await marked.return?.(undefined)
    }
  })
})

describe('combineDataSources', () => {
  test('keeps a stream kind when an overlay rotation patch is applied on top of it', async () => {
    const realData = new LocalStreamData([
      { link: 'https://a.example/s', kind: 'web' },
    ])
    const overlayData = new LocalStreamData()
    // Applied before the sources are read, so the merge below observes the
    // patch on the very first yield rather than racing a live update.
    overlayData.update('https://a.example/s', { rotation: 90 })

    const gen = combineDataSources(
      [
        markDataSource(realData.gen(), 'custom'),
        markDataSource(overlayData.gen(), 'overlay'),
      ],
      new StreamIDGenerator(),
    )
    try {
      const { value } = await gen.next()
      expect(value?.byURL?.get('https://a.example/s')).toMatchObject({
        kind: 'web',
        rotation: 90,
      })
    } finally {
      await gen.return?.(undefined)
    }
  })

  test('does not fabricate a stream from an overlay-only rotation patch', async () => {
    const realData = new LocalStreamData([])
    const overlayData = new LocalStreamData()
    overlayData.update('https://ghost.example/s', { rotation: 180 })

    const gen = combineDataSources(
      [
        markDataSource(realData.gen(), 'custom'),
        markDataSource(overlayData.gen(), 'overlay'),
      ],
      new StreamIDGenerator(),
    )
    try {
      const { value } = await gen.next()
      expect(value).toHaveLength(0)
      expect(value?.byURL?.has('https://ghost.example/s')).toBe(false)
    } finally {
      await gen.return?.(undefined)
    }
  })

  // Regression test for #264: Repeater.latest() (used internally here) keeps
  // one speculative .next() call in flight per source. Once two sources have
  // each produced a value and a second combined value has been pulled, that
  // speculative call sits pending on a source with no further data. Before
  // markDataSource() was rewritten as a Repeater (see data.ts), it was a
  // plain async generator, and native async generators queue .return() calls
  // behind any in-flight .next() - so tearing down the combined generator at
  // this point hung forever.
  test('return() resolves after a second value has been pulled from multiple live sources', async () => {
    const a = new LocalStreamData([
      { kind: 'video', link: 'https://a.example/s' },
    ])
    const b = new LocalStreamData([
      { kind: 'video', link: 'https://b.example/s' },
    ])

    const gen = combineDataSources(
      [markDataSource(a.gen(), 'a'), markDataSource(b.gen(), 'b')],
      new StreamIDGenerator(),
    )

    await gen.next()

    const pending = gen.next()
    await waitForListener(a, 'update')
    a.update('https://a.example/s', { label: 'updated' })
    await pending

    await expect(gen.return(undefined)).resolves.toBeDefined()
  })
})

describe('presetDataSource', () => {
  test('yields the pack entries once and stays open', async () => {
    const pack: PresetPack = {
      id: 'test-pack',
      name: 'Test Pack',
      entries: [{ link: 'https://a.example/s', kind: 'video', label: 'A' }],
    }
    const gen = presetDataSource(pack)
    try {
      const { value } = await gen.next()
      expect(value).toEqual([
        { link: 'https://a.example/s', kind: 'video', label: 'A' },
      ])
    } finally {
      await gen.return?.(undefined)
    }
  })

  test('combines with other sources via combineDataSources, tagged with the given source name', async () => {
    const pack: PresetPack = {
      id: 'de-tv',
      name: 'German Free-TV',
      entries: [{ link: 'https://ard.example/s', kind: 'video', label: 'ARD' }],
    }
    const idGen = new StreamIDGenerator()
    // combineDataSources()'s .return() never resolves (Repeater.latest does
    // not propagate return() to its contenders), so - matching the existing
    // combineDataSources tests above - read a single value and let the
    // generator get garbage-collected rather than tearing it down.
    const iterator = combineDataSources(
      [markDataSource(presetDataSource(pack), 'preset:de-tv')],
      idGen,
    )
    const { value } = await iterator.next()
    expect(value).toHaveLength(1)
    expect(value?.[0]).toMatchObject({
      link: 'https://ard.example/s',
      _dataSource: 'preset:de-tv',
    })
  })
})
