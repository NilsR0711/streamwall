import { Repeater } from '@repeaterjs/repeater'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { StreamDataContent } from 'streamwall-shared'
import { afterEach, describe, expect, test, vi } from 'vitest'
import log from '../logger'
import { combineDataSources, markDataSource } from './combine'
import { LocalStreamData } from './local'
import { StreamIDGenerator } from './parse'
import { pollDataURL } from './poll'
import { waitForListener } from './testHelpers'

// combineDataSources emits a snapshot as soon as *any* source has produced a
// value (see #596), instead of withholding everything until every source has
// spoken. A merge across N sources therefore converges over up to N snapshots
// rather than arriving complete in the very first one.
async function readUntil<T>(
  gen: AsyncIterator<T>,
  predicate: (value: T) => boolean,
  maxReads = 5,
): Promise<T> {
  let last: T | undefined
  for (let i = 0; i < maxReads; i++) {
    const { value, done } = await gen.next()
    if (done) {
      break
    }
    last = value
    if (predicate(value)) {
      return value
    }
  }
  throw new Error(
    `no snapshot matched after ${maxReads} reads (last: ${JSON.stringify(last)})`,
  )
}

describe('data source fan-out', () => {
  let server: Server | undefined

  afterEach(() => {
    server?.close()
    server = undefined
  })

  // Concurrency across sources lives one level up from the per-source loops:
  // combineDataSources advances every source at once, so N URLs are polled in
  // parallel even though each individual URL is polled serially.
  test('polls independent URLs concurrently rather than one after another', async () => {
    let inFlight = 0
    let maxInFlight = 0
    let pendingResponses: Array<() => void> = []

    const flush = () => {
      const responses = pendingResponses
      pendingResponses = []
      for (const respond of responses) {
        respond()
      }
    }

    server = createServer((req, res) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      pendingResponses.push(() => {
        inFlight--
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify([
            { link: `https://example.invalid${req.url}`, kind: 'video' },
          ]),
        )
      })
      if (pendingResponses.length >= 2) {
        flush()
      } else {
        // Safety valve so a serial implementation fails the assertion below
        // instead of hanging the test forever.
        setTimeout(flush, 500)
      }
    })
    await new Promise<void>((resolve) =>
      server!.listen(0, '127.0.0.1', resolve),
    )
    const { port } = server.address() as AddressInfo
    const base = `http://127.0.0.1:${port}/`

    const combined = combineDataSources(
      [
        markDataSource(pollDataURL(`${base}a`, 999), 'json-url'),
        markDataSource(pollDataURL(`${base}b`, 999), 'json-url'),
      ],
      new StreamIDGenerator(),
    )
    // The server holds every response until two requests have arrived, so a
    // first value can only be produced once both polls are in flight at the
    // same time.
    try {
      const { value } = await combined.next()
      expect(value).toBeDefined()
      expect(maxInFlight).toBe(2)
    } finally {
      await combined.return?.(undefined)
    }
  })

  // Error semantics of the fan-out: a source whose read fails yields an empty
  // batch and keeps going, so it must not suppress or delay the others.
  test('keeps delivering data from healthy sources when one source fails', async () => {
    server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify([{ link: 'https://good.example/s', kind: 'video' }]),
      )
    })
    await new Promise<void>((resolve) =>
      server!.listen(0, '127.0.0.1', resolve),
    )
    const { port } = server.address() as AddressInfo

    const combined = combineDataSources(
      [
        // Nothing is listening on this port, so this source always fails.
        markDataSource(pollDataURL('http://127.0.0.1:1/', 999), 'json-url'),
        markDataSource(
          pollDataURL(`http://127.0.0.1:${port}/`, 999),
          'json-url',
        ),
      ],
      new StreamIDGenerator(),
    )
    let seenGoodStream = false
    try {
      for (let i = 0; i < 5 && !seenGoodStream; i++) {
        const { value } = await combined.next()
        seenGoodStream = Boolean(
          value?.some((s) => s.link === 'https://good.example/s'),
        )
      }
    } finally {
      await combined.return?.(undefined)
    }
    expect(seenGoodStream).toBe(true)
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
      const value = await readUntil(gen, (v) => v[0]?.label === 'From B')
      expect(value).toHaveLength(1)
      expect(value[0]).toMatchObject({
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

  test('attaches a byId index to the yielded list for quick lookups', async () => {
    async function* sourceA() {
      yield [{ kind: 'video', link: 'https://a.example/s', source: 'Example' }]
    }
    const gen = combineDataSources([sourceA()], new StreamIDGenerator())
    try {
      const { value } = await gen.next()
      const stream = value?.[0]
      expect(stream?._id).toBeTruthy()
      expect(value?.byId?.get(stream!._id)).toBe(stream)
    } finally {
      await gen.return?.(undefined)
    }
  })

  test('omits id-less entries from the byId index instead of keying them on undefined', async () => {
    async function* sourceA() {
      // No source, label, or link text usable as an id base: the id generator
      // skips this entry, leaving `_id` unset.
      yield [{ kind: 'video', link: '' }]
    }
    const gen = combineDataSources([sourceA()], new StreamIDGenerator())
    try {
      const { value } = await gen.next()
      expect(value?.byId?.size).toBe(0)
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

  test('logs a warning naming the source and propagates when it rejects', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const failure = new Error('source exploded')
    const source = {
      next: () => Promise.reject(failure),
      return: async () => ({ done: true as const, value: undefined }),
      [Symbol.asyncIterator]() {
        return this
      },
    } as unknown as AsyncIterableIterator<StreamDataContent[]>

    const marked = markDataSource(source, 'boom')
    // The rejection must still surface to the consumer, not be silently
    // swallowed by the logging catch.
    await expect(marked.next()).rejects.toThrow('source exploded')
    expect(warnSpy).toHaveBeenCalledWith(
      'error advancing data source',
      'boom',
      failure,
    )

    warnSpy.mockRestore()
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
      const value = await readUntil(
        gen,
        (v) => v.byURL?.get('https://a.example/s')?.rotation != null,
      )
      expect(value.byURL?.get('https://a.example/s')).toMatchObject({
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
  // markDataSource() was rewritten as a Repeater (see combine.ts), it was a
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

  test('closes its sources on teardown', async () => {
    let markClosed!: () => void
    const closed = new Promise<void>((resolve) => {
      markClosed = resolve
    })
    const source = new Repeater<StreamDataContent[]>(async (push, stop) => {
      try {
        await push([{ kind: 'video', link: 'https://a.example/s' }])
        await stop
      } finally {
        markClosed()
      }
    })

    const gen = combineDataSources(
      [markDataSource(source, 'a')],
      new StreamIDGenerator(),
    )
    await gen.next()
    await gen.return(undefined)

    // Resolves only if the teardown propagated down to the source; otherwise
    // this await never settles and the test times out.
    await closed
  })

  // Regression tests for #596: a source that has not produced a first value
  // yet (a hung `--data.json-url`, a file that is never readable) must not
  // withhold the data every other source has already delivered.
  describe('with a source that has not yielded yet', () => {
    // A source that stays silent until `yieldBatch` is called, so the tests
    // below drive it by explicit promise resolution rather than by timing.
    function deferredSource(): {
      source: AsyncIterableIterator<StreamDataContent[]>
      yieldBatch: (batch: StreamDataContent[]) => void
    } {
      let yieldBatch!: (batch: StreamDataContent[]) => void
      const first = new Promise<StreamDataContent[]>((resolve) => {
        yieldBatch = resolve
      })
      const source = new Repeater<StreamDataContent[]>(async (push, stop) => {
        await push(await first)
        await stop
      })
      return { source, yieldBatch }
    }

    test('delivers a healthy source while another source stays silent', async () => {
      const { source: silent } = deferredSource()
      const healthy = new Repeater<StreamDataContent[]>(async (push, stop) => {
        await push([{ kind: 'video', link: 'https://good.example/s' }])
        await stop
      })

      const gen = combineDataSources(
        [markDataSource(silent, 'silent'), markDataSource(healthy, 'healthy')],
        new StreamIDGenerator(),
      )

      const { value } = await gen.next()
      expect(value?.map((s) => s.link)).toEqual(['https://good.example/s'])
    })

    test('delivers the silent source once it finally yields, without losing or duplicating data', async () => {
      const { source: slow, yieldBatch } = deferredSource()
      const healthy = new Repeater<StreamDataContent[]>(async (push, stop) => {
        await push([
          { kind: 'video', link: 'https://good.example/s', label: 'from fast' },
        ])
        await stop
      })

      // The slow source sits *after* the healthy one, so once it arrives its
      // fields must win the merge - the snapshot ordering of the underlying
      // sources has to survive the partial-first-value handling.
      const gen = combineDataSources(
        [markDataSource(healthy, 'healthy'), markDataSource(slow, 'slow')],
        new StreamIDGenerator(),
      )

      const first = await gen.next()
      expect(first.value?.map((s) => s.link)).toEqual([
        'https://good.example/s',
      ])

      const pending = gen.next()
      yieldBatch([
        { kind: 'video', link: 'https://good.example/s', label: 'from slow' },
        { kind: 'video', link: 'https://slow.example/s' },
      ])
      const { value } = await pending

      expect(value?.map((s) => s.link)).toEqual([
        'https://good.example/s',
        'https://slow.example/s',
      ])
      expect(value?.byURL?.get('https://good.example/s')).toMatchObject({
        label: 'from slow',
        _dataSource: 'slow',
      })
    })

    test('tears down while a source has never yielded', async () => {
      const { source: silent } = deferredSource()
      const healthy = new Repeater<StreamDataContent[]>(async (push, stop) => {
        await push([{ kind: 'video', link: 'https://good.example/s' }])
        await stop
      })

      const gen = combineDataSources(
        [markDataSource(silent, 'silent'), markDataSource(healthy, 'healthy')],
        new StreamIDGenerator(),
      )

      await gen.next()
      await expect(gen.return(undefined)).resolves.toBeDefined()
    })
  })
})
