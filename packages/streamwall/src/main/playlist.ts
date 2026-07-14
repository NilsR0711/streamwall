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

  constructor(
    private readonly playlists: PlaylistConfig[],
    private readonly deps: PlaylistSchedulerDeps,
  ) {}

  start() {
    for (const playlist of this.playlists) {
      this.cursors.set(playlist.view, 0)
      this.advance(playlist)
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
  }

  private advance(playlist: PlaylistConfig) {
    const cursor = this.cursors.get(playlist.view) ?? 0
    const url = playlist.urls[cursor % playlist.urls.length]
    const streamId = this.deps.resolveStreamId(url)
    if (streamId === undefined) {
      log.warn(
        `Playlist for view ${playlist.view}: no stream found for URL "${url}", skipping`,
      )
    } else {
      this.deps.setViewStream(playlist.view, streamId)
    }
    this.cursors.set(playlist.view, cursor + 1)
  }
}
