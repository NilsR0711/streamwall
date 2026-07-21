import { describe, expect, it, vi } from 'vitest'
import { LinuxUpdateChecker } from './linuxUpdateChecker'

/** A `fetch`-shaped stub resolving to a JSON body with the given status. */
function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    json: async () => body,
  }
}

function createChecker(
  overrides: Partial<ConstructorParameters<typeof LinuxUpdateChecker>[0]> = {},
) {
  const checker = new LinuxUpdateChecker({
    currentVersion: '0.9.1',
    repository: 'NilsR0711/streamwall',
    fetchImpl: async () =>
      jsonResponse({
        tag_name: 'v0.9.1',
        html_url: 'https://github.com/NilsR0711/streamwall/releases/tag/v0.9.1',
      }),
    ...overrides,
  })
  const statuses: unknown[] = []
  checker.on('status', (status) => statuses.push(status))
  return { checker, statuses }
}

describe('LinuxUpdateChecker.checkNow', () => {
  it('starts idle so the renderer renders no banner before a check has run', () => {
    const { checker } = createChecker()

    expect(checker.getStatus()).toEqual({ state: 'idle' })
  })

  it('reports an available update with a release page URL, never install semantics', async () => {
    const { checker, statuses } = createChecker({
      fetchImpl: async () =>
        jsonResponse({
          tag_name: 'v1.0.0',
          html_url:
            'https://github.com/NilsR0711/streamwall/releases/tag/v1.0.0',
        }),
    })

    const status = await checker.checkNow()

    expect(status).toEqual({
      state: 'available',
      version: '1.0.0',
      releaseUrl: 'https://github.com/NilsR0711/streamwall/releases/tag/v1.0.0',
    })
    expect(statuses).toEqual([status])
  })

  it('stays idle when the latest release is not newer than the running version', async () => {
    const { checker } = createChecker({
      fetchImpl: async () =>
        jsonResponse({
          tag_name: 'v0.9.1',
          html_url: 'https://example.test/r',
        }),
    })

    const status = await checker.checkNow()

    expect(status).toEqual({ state: 'idle' })
  })

  it('queries the GitHub releases API for the configured repository', async () => {
    const requestedUrls: string[] = []
    const { checker } = createChecker({
      fetchImpl: async (url: string) => {
        requestedUrls.push(url)
        return jsonResponse({
          tag_name: 'v0.9.1',
          html_url: 'https://example.test',
        })
      },
    })

    await checker.checkNow()

    expect(requestedUrls).toEqual([
      'https://api.github.com/repos/NilsR0711/streamwall/releases/latest',
    ])
  })

  it('never performs a request when the repository is unknown', async () => {
    let calls = 0
    const { checker } = createChecker({
      repository: null,
      fetchImpl: async () => {
        calls++
        return jsonResponse({})
      },
    })

    const status = await checker.checkNow()

    expect(calls).toBe(0)
    expect(status).toEqual({ state: 'idle' })
  })

  it('keeps the last known available status when a later check fails, so a transient network hiccup does not hide a real update', async () => {
    let fail = false
    const { checker } = createChecker({
      fetchImpl: async () => {
        if (fail) {
          throw new Error('network down')
        }
        return jsonResponse({
          tag_name: 'v1.0.0',
          html_url: 'https://example.test/releases/v1.0.0',
        })
      },
    })

    const first = await checker.checkNow()
    fail = true
    const second = await checker.checkNow()

    expect(second).toEqual(first)
  })

  it('skips draft and prerelease entries, treating them as no update', async () => {
    const { checker } = createChecker({
      fetchImpl: async () =>
        jsonResponse({
          tag_name: 'v1.0.0',
          html_url: 'https://example.test/r',
          draft: true,
        }),
    })

    const status = await checker.checkNow()

    expect(status).toEqual({ state: 'idle' })
  })

  it('does not emit a status event when a check changes nothing', async () => {
    const { checker, statuses } = createChecker({
      fetchImpl: async () =>
        jsonResponse({ tag_name: 'v0.9.1', html_url: 'https://example.test' }),
    })

    await checker.checkNow()
    await checker.checkNow()

    expect(statuses).toEqual([])
  })
})

describe('LinuxUpdateChecker.start/stop', () => {
  it('start() runs an immediate check and schedules periodic ones; stop() clears them', async () => {
    let calls = 0
    const timers: { fn: () => void; ms: number }[] = []
    const { checker } = createChecker({
      intervalMs: 1000,
      fetchImpl: async () => {
        calls++
        return jsonResponse({
          tag_name: 'v0.9.1',
          html_url: 'https://example.test',
        })
      },
      setIntervalImpl: (fn: () => void, ms: number) => {
        timers.push({ fn, ms })
        return timers.length
      },
      clearIntervalImpl: (handle: unknown) => {
        timers.splice(Number(handle) - 1, 1)
      },
    })

    checker.start()
    await vi.waitFor(() => expect(calls).toBe(1))

    expect(timers).toEqual([{ fn: timers[0]?.fn, ms: 1000 }])

    checker.stop()
    expect(timers.length).toBe(0)
  })

  it('start() is idempotent (no duplicate intervals)', () => {
    const timers: unknown[] = []
    const { checker } = createChecker({
      setIntervalImpl: () => {
        timers.push({})
        return timers.length
      },
      clearIntervalImpl: () => {
        timers.pop()
      },
    })

    checker.start()
    checker.start()

    expect(timers.length).toBe(1)
    checker.stop()
  })
})
