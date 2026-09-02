import {
  layerLinksKey,
  MAX_BLOCKED_LAYER_URL_LENGTH,
  MAX_BLOCKED_LAYER_URLS,
  type StreamData,
} from 'streamwall-shared'

function truncate(url: string): string {
  return url.length > MAX_BLOCKED_LAYER_URL_LENGTH
    ? `${url.slice(0, MAX_BLOCKED_LAYER_URL_LENGTH - 1)}…`
    : url
}

/**
 * Collects the URLs the wall's hardened layer sessions refused, for the
 * broadcast state the control UI reads (issue #797).
 *
 * The wall renders its own notice (#790), but that only reaches somebody
 * standing at the wall. In a control-server deployment the operator who typed
 * the overlay or background link can be on another machine entirely, where the
 * layer still just silently does nothing.
 *
 * Every method returns the new list, or `null` when nothing changed: a page
 * inside a layer can poll a refused endpoint with a cache-busting query
 * string, which must not re-broadcast the whole state at request rate.
 *
 * The list is bounded in both directions, because it is the framed page and
 * not the operator that decides what gets requested. Each URL is truncated to
 * what the state schema carries, and once the list is full further *new* URLs
 * are dropped rather than evicting what is already there, so layer content
 * cannot push the operator's own refused link out of the notice.
 */
export class BlockedLayerURLTracker {
  private urls: string[] = []
  private linksKey: string | undefined

  /** Records one refused URL. */
  report(url: string): string[] | null {
    if (this.urls.length >= MAX_BLOCKED_LAYER_URLS) {
      return null
    }
    const shown = truncate(url)
    if (this.urls.includes(shown)) {
      return null
    }
    this.urls = [...this.urls, shown]
    return this.urls
  }

  /**
   * Re-reads the layer links from the latest state and clears the list when
   * the operator has changed one of them. That edit remounts every layer frame
   * on the wall, so anything still refused reports itself again.
   *
   * Learning the links for the first time is not an edit: the reports the
   * guard makes during startup arrive before any state does.
   */
  syncLayerLinks(streams: readonly StreamData[]): string[] | null {
    const previous = this.linksKey
    this.linksKey = layerLinksKey(streams)
    if (previous === undefined || previous === this.linksKey) {
      return null
    }
    if (this.urls.length === 0) {
      return null
    }
    this.urls = []
    return this.urls
  }
}
