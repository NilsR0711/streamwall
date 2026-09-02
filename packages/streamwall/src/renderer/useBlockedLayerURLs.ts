import { useEffect, useRef, useState } from 'preact/hooks'

/** Subscribes to the layer's blocked-URL reports; returns an unsubscribe. */
export type BlockedURLSubscribe = (
  handleBlocked: (url: string) => void,
) => () => void

/** How many blocked URLs the wall shows at once. */
export const MAX_BLOCKED_URLS = 5

/**
 * How long a URL stays on the wall after it was last refused. Once the operator
 * fixes the address, the notice has to go away on its own: the layer page is
 * never reloaded on a config change (new streams are pushed into the live
 * page), so nothing else would ever clear it.
 */
export const BLOCKED_URL_TTL_MS = 60_000

/** How often reports are folded into rendered state (see below). */
export const BLOCKED_URL_FLUSH_MS = 500

// Reports are buffered rather than rendered as they arrive: a page inside a
// layer can poll a refused endpoint with a cache-busting query string, which
// would otherwise re-render the whole wall at request rate. The buffer itself
// is capped for the same reason.
const MAX_BUFFERED_URLS = MAX_BLOCKED_URLS * 4

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((url, i) => url === b[i])
}

/**
 * The URLs this layer's session most recently refused to fetch, oldest first,
 * so the wall can say what happened instead of just going blank (#790).
 *
 * Reports are not matched against the layer's stream list, and no frame is
 * unmounted on their account: the guard reports the request it actually
 * cancelled, which for a redirected link or a refused sub-resource is not the
 * URL the operator typed. Showing what was refused, next to whatever did
 * render, states exactly what is known without guessing at attribution — and
 * leaves a link that was blocked once free to succeed on the next attempt.
 */
export function useBlockedLayerURLs(
  subscribe: BlockedURLSubscribe,
): readonly string[] {
  // url -> when it was last refused.
  const seen = useRef(new Map<string, number>())
  const [urls, setURLs] = useState<readonly string[]>([])

  useEffect(() => {
    const unsubscribe = subscribe((url) => {
      // Re-inserting refreshes the timestamp while keeping the Map's insertion
      // order, so a URL still being refused stays put rather than jumping to
      // the end of the list.
      seen.current.set(url, Date.now())
      while (seen.current.size > MAX_BUFFERED_URLS) {
        const [oldest] = seen.current.keys()
        seen.current.delete(oldest)
      }
    })

    const flush = setInterval(() => {
      const cutoff = Date.now() - BLOCKED_URL_TTL_MS
      for (const [url, at] of seen.current) {
        if (at <= cutoff) {
          seen.current.delete(url)
        }
      }
      const next = [...seen.current.keys()].slice(-MAX_BLOCKED_URLS)
      setURLs((previous) => (sameList(previous, next) ? previous : next))
    }, BLOCKED_URL_FLUSH_MS)

    return () => {
      unsubscribe()
      clearInterval(flush)
    }
  }, [subscribe])

  return urls
}
