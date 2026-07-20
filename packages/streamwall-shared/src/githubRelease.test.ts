import { describe, expect, it } from 'vitest'
import { fetchLatestGithubRelease, isNewerVersion } from './githubRelease.ts'

/** A `fetch`-shaped stub resolving to a JSON body with the given status. */
function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    json: async () => body,
  }
}

describe('isNewerVersion', () => {
  it('detects a newer major/minor/patch release', () => {
    expect(isNewerVersion('1.0.0', '0.9.1')).toBe(true)
    expect(isNewerVersion('0.10.0', '0.9.1')).toBe(true)
    expect(isNewerVersion('0.9.2', '0.9.1')).toBe(true)
  })

  it('ignores an equal or older release', () => {
    expect(isNewerVersion('0.9.1', '0.9.1')).toBe(false)
    expect(isNewerVersion('0.9.0', '0.9.1')).toBe(false)
    expect(isNewerVersion('0.9.1', '0.10.0')).toBe(false)
  })

  it('tolerates a leading "v" on either side (release tags carry one)', () => {
    expect(isNewerVersion('v1.0.0', '0.9.1')).toBe(true)
    expect(isNewerVersion('v0.9.1', 'v0.9.1')).toBe(false)
  })

  it('compares numeric segments numerically, not lexically', () => {
    expect(isNewerVersion('0.9.10', '0.9.9')).toBe(true)
    expect(isNewerVersion('0.9.9', '0.9.10')).toBe(false)
  })

  it('ranks a prerelease below its own release', () => {
    expect(isNewerVersion('2.0.0-pre1', '2.0.0')).toBe(false)
    expect(isNewerVersion('2.0.0', '2.0.0-pre1')).toBe(true)
    expect(isNewerVersion('2.0.0-pre2', '2.0.0-pre1')).toBe(true)
  })

  it('treats an unparsable version as "no update" rather than throwing', () => {
    expect(isNewerVersion('not-a-version', '0.9.1')).toBe(false)
    expect(isNewerVersion('1.0.0', 'not-a-version')).toBe(false)
    expect(isNewerVersion('', '0.9.1')).toBe(false)
  })
})

describe('fetchLatestGithubRelease', () => {
  const url = 'https://api.github.com/repos/example/example/releases/latest'

  it('returns the tag and html_url of the latest release', async () => {
    const result = await fetchLatestGithubRelease({
      url,
      fetchImpl: async () =>
        jsonResponse({
          tag_name: 'v1.2.3',
          html_url: 'https://example.test/releases/v1.2.3',
        }),
    })

    expect(result).toEqual({
      version: '1.2.3',
      url: 'https://example.test/releases/v1.2.3',
    })
  })

  it('skips draft and prerelease entries', async () => {
    for (const flags of [{ draft: true }, { prerelease: true }]) {
      const result = await fetchLatestGithubRelease({
        url,
        fetchImpl: async () =>
          jsonResponse({
            tag_name: 'v1.2.3',
            html_url: 'https://example.test/r',
            ...flags,
          }),
      })
      expect(result).toBeNull()
    }
  })

  it('returns null on a non-2xx response', async () => {
    const result = await fetchLatestGithubRelease({
      url,
      fetchImpl: async () => jsonResponse({ message: 'Not Found' }, 404),
    })
    expect(result).toBeNull()
  })

  it('returns null on a malformed payload instead of throwing', async () => {
    const result = await fetchLatestGithubRelease({
      url,
      fetchImpl: async () => jsonResponse({ nope: true }),
    })
    expect(result).toBeNull()
  })

  it('returns null when the request fails (offline, DNS, timeout)', async () => {
    const result = await fetchLatestGithubRelease({
      url,
      fetchImpl: async () => {
        throw new Error('getaddrinfo ENOTFOUND api.github.com')
      },
    })
    expect(result).toBeNull()
  })

  it('aborts a hung request via the request signal', async () => {
    const result = await fetchLatestGithubRelease({
      url,
      timeoutMs: 10,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          )
        }),
    })
    expect(result).toBeNull()
  })

  it('requests the given url with the default accept header', async () => {
    const requests: { url: string; headers?: Record<string, string> }[] = []
    await fetchLatestGithubRelease({
      url,
      fetchImpl: async (requestedUrl, init) => {
        requests.push({ url: requestedUrl, headers: init?.headers })
        return jsonResponse({
          tag_name: 'v1.2.3',
          html_url: 'https://example.test/r',
        })
      },
    })

    expect(requests).toEqual([
      { url, headers: { accept: 'application/vnd.github+json' } },
    ])
  })

  it('merges caller-supplied headers with the default accept header', async () => {
    const requests: { headers?: Record<string, string> }[] = []
    await fetchLatestGithubRelease({
      url,
      headers: { 'user-agent': 'streamwall-control-server/1.2.3' },
      fetchImpl: async (_url, init) => {
        requests.push({ headers: init?.headers })
        return jsonResponse({
          tag_name: 'v1.2.3',
          html_url: 'https://example.test/r',
        })
      },
    })

    expect(requests).toEqual([
      {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'streamwall-control-server/1.2.3',
        },
      },
    ])
  })
})
