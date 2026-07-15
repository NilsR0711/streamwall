import log from './logger'

export interface PlaylistConfig {
  view: number
  /** Seconds between advances. */
  interval: number
  urls: string[]
}

export interface PlaylistSchedulerDeps {
  /** Resolves a configured URL to its current stream ID, if one exists. */
  resolveStreamId: (url: string) => string | undefined
  setViewStream: (view: number, streamId: string) => void
}

/**
 * Cycles each configured view through its list of stream URLs on a timer.
 *
 * URLs are resolved to stream IDs at the moment each advance fires (rather
 * than once at startup) since the underlying stream data can change as data
 * sources refresh.
 */
export class PlaylistScheduler {
  private readonly timers: ReturnType<typeof setInterval>[] = []
  private readonly cursors = new Map<number, number>()
  private readonly pending = new Set<PlaylistConfig>()

  constructor(
    private readonly playlists: PlaylistConfig[],
    private readonly deps: PlaylistSchedulerDeps,
  ) {}

  start() {
    for (const playlist of this.playlists) {
      this.cursors.set(playlist.view, 0)
      this.resolve(playlist)
      this.timers.push(
        setInterval(() => this.advance(playlist), playlist.interval * 1000),
      )
    }
  }

  stop() {
    for (const timer of this.timers) {
      clearInterval(timer)
    }
    this.timers.length = 0
    this.pending.clear()
  }

  /**
   * Re-resolves the current URL for every view that failed to resolve on
   * its last advance, without moving on to the next URL in the playlist.
   * Call this whenever stream data refreshes so a view fills in as soon as
   * its URL becomes resolvable, instead of staying empty until the next
   * interval tick.
   */
  retryPending() {
    for (const playlist of this.pending) {
      this.resolve(playlist)
    }
  }

  private advance(playlist: PlaylistConfig) {
    const cursor = (this.cursors.get(playlist.view) ?? 0) + 1
    this.cursors.set(playlist.view, cursor)
    this.resolve(playlist)
  }

  private resolve(playlist: PlaylistConfig) {
    const cursor = this.cursors.get(playlist.view) ?? 0
    const url = playlist.urls[cursor % playlist.urls.length]
    const streamId = this.deps.resolveStreamId(url)
    if (streamId === undefined) {
      this.pending.add(playlist)
      log.warn(
        `Playlist for view ${playlist.view}: no stream found for URL "${url}", skipping`,
      )
    } else {
      this.pending.delete(playlist)
      this.deps.setViewStream(playlist.view, streamId)
    }
  }
}
