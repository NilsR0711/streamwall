import { afterEach, describe, expect, it, vi } from 'vitest'
import { type LocalStreamData } from './data'
import { buildDataSources } from './dataSources'
import log from './logger'

/** A LocalStreamData stand-in whose gen() yields nothing. */
function fakeStreamData(): Pick<LocalStreamData, 'gen'> {
  return {
    gen: () =>
      (async function* () {
        // No data emitted; the source is never iterated in these tests.
      })() as ReturnType<LocalStreamData['gen']>,
  }
}

function baseInput() {
  return {
    jsonUrls: [] as string[],
    tomlFiles: [] as string[],
    presets: [] as string[],
    interval: 30,
    localStreamData: fakeStreamData(),
    overlayStreamData: fakeStreamData(),
    trackDataSourceHealth: vi.fn(() => vi.fn()),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('buildDataSources', () => {
  it('always includes the custom and overlay sources', () => {
    const sources = buildDataSources(baseInput())
    expect(sources).toHaveLength(2)
  })

  it('adds one source per json-url and toml-file with health tracking', () => {
    const trackDataSourceHealth = vi.fn(() => vi.fn())
    const sources = buildDataSources({
      ...baseInput(),
      jsonUrls: ['http://a', 'http://b'],
      tomlFiles: ['/streams.toml'],
      trackDataSourceHealth,
    })

    // 2 json-url + 1 toml-file + custom + overlay
    expect(sources).toHaveLength(5)
    expect(trackDataSourceHealth).toHaveBeenCalledWith('http://a', 'json-url')
    expect(trackDataSourceHealth).toHaveBeenCalledWith('http://b', 'json-url')
    expect(trackDataSourceHealth).toHaveBeenCalledWith(
      '/streams.toml',
      'toml-file',
    )
  })

  it('includes a source for a known preset pack', () => {
    const sources = buildDataSources({ ...baseInput(), presets: ['de-tv'] })
    // de-tv preset + custom + overlay
    expect(sources).toHaveLength(3)
  })

  it('warns about and skips an unknown preset pack', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => log)
    const sources = buildDataSources({
      ...baseInput(),
      presets: ['does-not-exist'],
    })

    // Only custom + overlay; the unknown preset is skipped.
    expect(sources).toHaveLength(2)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unknown preset pack "does-not-exist"'),
    )
  })
})
