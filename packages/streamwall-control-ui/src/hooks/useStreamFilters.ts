import { type JSX } from 'preact'
import { useCallback, useMemo, useState } from 'preact/hooks'
import { type StreamData } from 'streamwall-shared'
import { type CollabData } from '../collabData.ts'

const normalStreamKinds = new Set(['video', 'audio', 'web'])

/**
 * Partition the visible streams into the four sidebar buckets — streams placed
 * on the wall, live streams, everything else, and (independently) favorites.
 * `filter` matches case-insensitively against the label/source/state/city text.
 * Exported for unit testing; `useStreamFilters` is the component-facing wrapper.
 */
export function filterStreams(
  streams: StreamData[],
  wallStreamIds: Set<string>,
  favoriteLinks: ReadonlySet<string>,
  filter: string,
): [StreamData[], StreamData[], StreamData[], StreamData[]] {
  const wallStreams = []
  const liveStreams = []
  const otherStreams = []
  const favoriteStreams = []
  for (const stream of streams) {
    const { _id, kind, status, label, source, state, city, link } = stream
    if (kind && !normalStreamKinds.has(kind)) {
      continue
    }
    if (
      filter !== '' &&
      !`${label}${source}${state}${city}`
        .toLowerCase()
        .includes(filter.toLowerCase())
    ) {
      continue
    }
    if (favoriteLinks.has(link)) {
      favoriteStreams.push(stream)
    }
    if (wallStreamIds.has(_id)) {
      wallStreams.push(stream)
    } else if ((kind && kind !== 'video') || status === 'Live') {
      liveStreams.push(stream)
    } else {
      otherStreams.push(stream)
    }
  }
  return [wallStreams, liveStreams, otherStreams, favoriteStreams]
}

/**
 * Owns the sidebar's stream-filter text box and derives the memoized favorites
 * set, the set of stream ids currently placed on the wall, and the four
 * partitioned stream buckets the sidebar renders (issue #393).
 */
export function useStreamFilters({
  streams,
  sharedState,
  favorites,
}: {
  streams: StreamData[]
  sharedState: CollabData | undefined
  favorites: string[]
}) {
  const [streamFilter, setStreamFilter] = useState('')
  const handleStreamFilterChange = useCallback<
    JSX.InputEventHandler<HTMLInputElement>
  >((ev) => {
    setStreamFilter(ev.currentTarget?.value)
  }, [])

  const favoritesSet = useMemo(() => new Set(favorites), [favorites])

  const wallStreamIds = useMemo(
    () =>
      new Set(
        Object.values(sharedState?.views ?? {})
          .map(({ streamId }) => streamId)
          .filter((x) => x !== undefined),
      ),
    [sharedState],
  )

  const [wallStreams, liveStreams, otherStreams, favoriteStreams] = useMemo(
    () => filterStreams(streams, wallStreamIds, favoritesSet, streamFilter),
    [streams, wallStreamIds, favoritesSet, streamFilter],
  )

  return {
    streamFilter,
    handleStreamFilterChange,
    favoritesSet,
    wallStreams,
    liveStreams,
    otherStreams,
    favoriteStreams,
  }
}
