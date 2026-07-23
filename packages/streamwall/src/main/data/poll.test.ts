import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { StreamDataContent } from 'streamwall-shared'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { computeFetchTimeoutMs, pollDataURL } from './poll'

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

  // The serial `await fetch()` in pollDataURL's loop is deliberate: the loop
  // is a polling interval over one endpoint, so a request must never be
  // issued while the previous one for the same URL is still in flight.
  test('never issues overlapping requests for a single URL', async () => {
    let inFlight = 0
    let maxInFlight = 0
    let counter = 0
    server = createServer((_req, res) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      setTimeout(() => {
        inFlight--
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify([
            { link: `https://a.example/${counter++}`, kind: 'video' },
          ]),
        )
      }, 20)
    })
    await new Promise<void>((resolve) =>
      server!.listen(0, '127.0.0.1', resolve),
    )
    const { port } = server.address() as AddressInfo
    const url = `http://127.0.0.1:${port}/`

    const gen = pollDataURL(url, 0.01)
    try {
      for (let i = 0; i < 3; i++) {
        await gen.next()
      }
      expect(maxInFlight).toBe(1)
    } finally {
      await gen.return(undefined)
    }
  })

  // These two tests drive the client-side fetch timeout (#603) with
  // vi.useFakeTimers() rather than real setTimeout races: the abort timer
  // is advanced by an exact, known amount, and the HTTP response is
  // released only after that advance, on an explicit "the server received
  // the request" promise rather than a real delay. That keeps the pass/fail
  // boundary deterministic instead of depending on how fast this machine's
  // event loop happens to be, which matters because this file's tests run
  // in CI on three platforms.
  test('reports unhealthy after a client-side timeout and recovers on the next successful poll', async () => {
    // Fake only setTimeout/clearTimeout: pollDataURL's abort timer and its
    // inter-poll `sleep()` are both built on those, but leaving
    // setImmediate/process.nextTick real matters because Node's own
    // http/net internals lean on them to deliver this test's real loopback
    // response - faking those too stalls the request indefinitely.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      let requestCount = 0
      let firstRequestReceived: () => void
      const firstRequestReceivedP = new Promise<void>((resolve) => {
        firstRequestReceived = resolve
      })
      let secondRequestReceived: () => void
      const secondRequestReceivedP = new Promise<void>((resolve) => {
        secondRequestReceived = resolve
      })
      server = createServer((_req, res) => {
        requestCount++
        if (requestCount === 1) {
          // Simulates a host that accepts the connection and never answers.
          firstRequestReceived()
          return
        }
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify([{ link: 'https://a.example/s', kind: 'video' }]),
        )
        secondRequestReceived()
      })
      await new Promise<void>((resolve) =>
        server!.listen(0, '127.0.0.1', resolve),
      )
      const { port } = server.address() as AddressInfo
      const url = `http://127.0.0.1:${port}/`

      const intervalSecs = 10
      const timeoutMs = computeFetchTimeoutMs(intervalSecs * 1000)
      const onHealth = vi.fn()
      const gen = pollDataURL(url, intervalSecs, onHealth)
      try {
        const firstP = gen.next()
        // Let the real request actually land at the server before
        // fast-forwarding the fake clock, so the abort timer cannot fire
        // before the request was ever sent.
        await firstRequestReceivedP
        await vi.advanceTimersByTimeAsync(timeoutMs)
        const first = await firstP
        expect(onHealth).toHaveBeenCalledWith(
          false,
          expect.stringContaining('timed out'),
        )
        expect(first.value).toEqual([])

        const secondP = gen.next()
        await vi.advanceTimersByTimeAsync(intervalSecs * 1000)
        await secondRequestReceivedP
        const second = await secondP
        expect(second.value?.map((s: StreamDataContent) => s.link)).toEqual([
          'https://a.example/s',
        ])
        expect(onHealth).toHaveBeenCalledWith(true)
      } finally {
        await gen.return(undefined)
      }
    } finally {
      vi.useRealTimers()
    }
  })

  test('does not report unhealthy status for a response that resolves under the timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      let pendingRes: import('node:http').ServerResponse | undefined
      let requestReceived: () => void
      const requestReceivedP = new Promise<void>((resolve) => {
        requestReceived = resolve
      })
      server = createServer((_req, res) => {
        pendingRes = res
        requestReceived()
      })
      await new Promise<void>((resolve) =>
        server!.listen(0, '127.0.0.1', resolve),
      )
      const { port } = server.address() as AddressInfo
      const url = `http://127.0.0.1:${port}/`

      const intervalSecs = 10
      const timeoutMs = computeFetchTimeoutMs(intervalSecs * 1000)
      const onHealth = vi.fn()
      const gen = pollDataURL(url, intervalSecs, onHealth)
      try {
        const firstP = gen.next()
        await requestReceivedP

        // Advance to just under the timeout: the endpoint is slow, not dead,
        // so no abort should fire yet.
        await vi.advanceTimersByTimeAsync(timeoutMs - 1000)
        pendingRes!.setHeader('content-type', 'application/json')
        pendingRes!.end(
          JSON.stringify([{ link: 'https://a.example/s', kind: 'video' }]),
        )

        const first = await firstP
        expect(first.value?.map((s: StreamDataContent) => s.link)).toEqual([
          'https://a.example/s',
        ])
        expect(onHealth).toHaveBeenCalledWith(true)
        expect(onHealth).not.toHaveBeenCalledWith(false, expect.any(String))
      } finally {
        await gen.return(undefined)
      }
    } finally {
      vi.useRealTimers()
    }
  })
})
