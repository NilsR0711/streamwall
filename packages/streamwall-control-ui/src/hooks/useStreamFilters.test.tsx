import { render } from 'preact'
import { act } from 'preact/test-utils'
import type { StreamData } from 'streamwall-shared'
import { afterEach, describe, expect, test } from 'vitest'
import { type CollabData } from '../collabData.ts'
import { filterStreams, useStreamFilters } from './useStreamFilters.ts'

function makeStream(
  id: string,
  overrides: Partial<StreamData> = {},
): StreamData {
  return {
    _id: id,
    _dataSource: 'test',
    kind: 'video',
    link: `https://example.com/${id}`,
    ...overrides,
  }
}

describe('filterStreams', () => {
  test('places streams assigned to the wall in the wall bucket', () => {
    const onWall = makeStream('a')
    const offWall = makeStream('b')
    const [wall, live, other] = filterStreams(
      [onWall, offWall],
      new Set(['a']),
      new Set(),
      '',
    )
    expect(wall).toEqual([onWall])
    expect(live).toEqual([])
    expect(other).toEqual([offWall])
  })

  test('treats non-video kinds and Live video as live streams', () => {
    const audio = makeStream('a', { kind: 'audio' })
    const web = makeStream('b', { kind: 'web' })
    const liveVideo = makeStream('c', { kind: 'video', status: 'Live' })
    const idleVideo = makeStream('d', { kind: 'video' })
    const [, live, other] = filterStreams(
      [audio, web, liveVideo, idleVideo],
      new Set(),
      new Set(),
      '',
    )
    expect(live).toEqual([audio, web, liveVideo])
    expect(other).toEqual([idleVideo])
  })

  test('drops kinds outside the normal video/audio/web set entirely', () => {
    const overlay = makeStream('a', {
      kind: 'background' as StreamData['kind'],
    })
    const video = makeStream('b')
    const [wall, live, other, favorites] = filterStreams(
      [overlay, video],
      new Set(),
      new Set(),
      '',
    )
    expect([...wall, ...live, ...other, ...favorites]).toEqual([video])
  })

  test('collects favorites by link independently of the primary bucket', () => {
    const fav = makeStream('a', { link: 'https://fav.example/x' })
    const notFav = makeStream('b')
    const [, , , favorites] = filterStreams(
      [fav, notFav],
      new Set(),
      new Set(['https://fav.example/x']),
      '',
    )
    expect(favorites).toEqual([fav])
  })

  test('matches the filter case-insensitively across label/source/state/city', () => {
    const match = makeStream('a', { city: 'Portland' })
    const miss = makeStream('b', { city: 'Seattle' })
    const [, , other] = filterStreams(
      [match, miss],
      new Set(),
      new Set(),
      'portl',
    )
    expect(other).toEqual([match])
  })

  test('an empty filter keeps every stream', () => {
    const streams = [makeStream('a'), makeStream('b', { kind: 'audio' })]
    const [, live, other] = filterStreams(streams, new Set(), new Set(), '')
    expect(live.length + other.length).toBe(2)
  })

  // label/source/state/city are all optional (streamwall-shared schemas), so
  // a stream carrying only a link - every freshly added custom stream, and
  // any sparse external source row - has all four undefined. Naively
  // template-interpolating them produces the literal string
  // "undefinedundefinedundefinedundefined", which then matches any substring
  // of "undefined" (issue #747).
  describe('streams with no label/source/state/city metadata (issue #747)', () => {
    test('does not match a filter that is a substring of the literal word "undefined"', () => {
      const bareStream = makeStream('a')

      for (const substring of ['un', 'def', 'ine', 'ned', 'fin']) {
        const [, , other] = filterStreams(
          [bareStream],
          new Set(),
          new Set(),
          substring,
        )
        expect(other).toEqual([])
      }
    })

    test('is excluded by any non-empty filter, having no metadata to match', () => {
      const bareStream = makeStream('a')
      const [wall, live, other, favorites] = filterStreams(
        [bareStream],
        new Set(),
        new Set(),
        'anything',
      )
      expect([...wall, ...live, ...other, ...favorites]).toEqual([])
    })

    test('does not let a match span a field boundary', () => {
      // Without a separator, label "foo" + source "bar" reads as "foobar",
      // which would wrongly match a filter for "oob".
      const stream = makeStream('a', { label: 'foo', source: 'bar' })
      const [, , other] = filterStreams([stream], new Set(), new Set(), 'oob')
      expect(other).toEqual([])
    })
  })
})

let container: HTMLDivElement | undefined

afterEach(() => {
  if (container) {
    act(() => render(null, container!))
    container.remove()
    container = undefined
  }
})

function Probe({
  streams,
  sharedState,
  favorites,
}: {
  streams: StreamData[]
  sharedState: CollabData | undefined
  favorites: string[]
}) {
  const { favoritesSet, wallStreams, liveStreams, otherStreams } =
    useStreamFilters({ streams, sharedState, favorites })
  return (
    <div
      data-testid="probe"
      data-wall={wallStreams.map((s) => s._id).join(',')}
      data-live={liveStreams.map((s) => s._id).join(',')}
      data-other={otherStreams.map((s) => s._id).join(',')}
      data-favset={[...favoritesSet].join(',')}
    />
  )
}

describe('useStreamFilters', () => {
  test('derives wall placement from sharedState and exposes the favorites set', () => {
    const streams = [
      makeStream('a'),
      makeStream('b', { kind: 'audio' }),
      makeStream('c'),
    ]
    const sharedState = {
      views: { 0: { streamId: 'a' } },
    } as unknown as CollabData
    container = document.createElement('div')
    document.body.appendChild(container)
    act(() => {
      render(
        <Probe
          streams={streams}
          sharedState={sharedState}
          favorites={['https://example.com/c']}
        />,
        container!,
      )
    })
    const probe = container.querySelector('[data-testid="probe"]')!
    expect(probe.getAttribute('data-wall')).toBe('a')
    expect(probe.getAttribute('data-live')).toBe('b')
    expect(probe.getAttribute('data-other')).toBe('c')
    expect(probe.getAttribute('data-favset')).toBe('https://example.com/c')
  })
})
