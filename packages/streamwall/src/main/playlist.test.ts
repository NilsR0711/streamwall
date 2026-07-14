import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { PlaylistScheduler } from './playlist'

describe('PlaylistScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function makeDeps(streamIdByURL: Record<string, string | undefined>) {
    const setViewStream = vi.fn()
    return {
      setViewStream,
      resolveStreamId: vi.fn((url: string) => streamIdByURL[url]),
    }
  }

  test('assigns the first URL to its view as soon as it starts', () => {
    const deps = makeDeps({ a: 'stream-a', b: 'stream-b' })
    const scheduler = new PlaylistScheduler(
      [{ view: 0, interval: 10, urls: ['a', 'b'] }],
      deps,
    )

    scheduler.start()

    expect(deps.setViewStream).toHaveBeenCalledTimes(1)
    expect(deps.setViewStream).toHaveBeenCalledWith(0, 'stream-a')
  })

  test('cycles through the configured URLs on each interval, wrapping around', () => {
    const deps = makeDeps({ a: 'stream-a', b: 'stream-b', c: 'stream-c' })
    const scheduler = new PlaylistScheduler(
      [{ view: 0, interval: 10, urls: ['a', 'b', 'c'] }],
      deps,
    )

    scheduler.start()
    deps.setViewStream.mockClear()

    vi.advanceTimersByTime(10_000)
    expect(deps.setViewStream).toHaveBeenNthCalledWith(1, 0, 'stream-b')

    vi.advanceTimersByTime(10_000)
    expect(deps.setViewStream).toHaveBeenNthCalledWith(2, 0, 'stream-c')

    vi.advanceTimersByTime(10_000)
    expect(deps.setViewStream).toHaveBeenNthCalledWith(3, 0, 'stream-a')
  })

  test('advances multiple views independently, each on its own interval', () => {
    const deps = makeDeps({
      a: 'stream-a',
      b: 'stream-b',
      x: 'stream-x',
      y: 'stream-y',
    })
    const scheduler = new PlaylistScheduler(
      [
        { view: 0, interval: 15, urls: ['a', 'b'] },
        { view: 1, interval: 20, urls: ['x', 'y'] },
      ],
      deps,
    )

    scheduler.start()
    deps.setViewStream.mockClear()

    vi.advanceTimersByTime(15_000)
    expect(deps.setViewStream).toHaveBeenCalledExactlyOnceWith(0, 'stream-b')

    deps.setViewStream.mockClear()
    vi.advanceTimersByTime(5_000)
    expect(deps.setViewStream).toHaveBeenCalledExactlyOnceWith(1, 'stream-y')
  })

  test('skips a URL that has no resolvable stream yet without getting stuck', () => {
    const deps = makeDeps({ a: 'stream-a', b: undefined, c: 'stream-c' })
    const scheduler = new PlaylistScheduler(
      [{ view: 0, interval: 10, urls: ['a', 'b', 'c'] }],
      deps,
    )
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    scheduler.start()
    deps.setViewStream.mockClear()

    vi.advanceTimersByTime(10_000)
    expect(deps.setViewStream).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('view 0'))

    vi.advanceTimersByTime(10_000)
    expect(deps.setViewStream).toHaveBeenCalledExactlyOnceWith(0, 'stream-c')

    warnSpy.mockRestore()
  })

  test('stop() clears all timers so no further advances happen', () => {
    const deps = makeDeps({ a: 'stream-a', b: 'stream-b' })
    const scheduler = new PlaylistScheduler(
      [{ view: 0, interval: 10, urls: ['a', 'b'] }],
      deps,
    )

    scheduler.start()
    deps.setViewStream.mockClear()
    scheduler.stop()

    vi.advanceTimersByTime(60_000)
    expect(deps.setViewStream).not.toHaveBeenCalled()
  })

  test('does nothing for an empty playlist configuration', () => {
    const deps = makeDeps({})
    const scheduler = new PlaylistScheduler([], deps)

    expect(() => scheduler.start()).not.toThrow()
    vi.advanceTimersByTime(60_000)
    expect(deps.setViewStream).not.toHaveBeenCalled()
  })
})
