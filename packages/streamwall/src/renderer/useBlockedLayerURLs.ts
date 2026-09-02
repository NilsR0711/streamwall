import { useEffect, useRef, useState } from 'preact/hooks'
import type { StreamList } from 'streamwall-shared'

/** Subscribes to the layer's blocked-URL reports; returns an unsubscribe. */
export type BlockedURLSubscribe = (
  handleBlocked: (url: string) => void,
) => () => void

/** How many refused URLs the wall shows at once. */
export const MAX_BLOCKED_URLS = 5

/** How often buffered reports are folded into rendered state (see below). */
export const BLOCKED_URL_FLUSH_MS = 500

/**
 * A `resetKey` for {@link useBlockedLayerURLs}: the links the wall's two chrome
 * layers are framing. Changing one of them is the operator's edit, which
 * remounts the frames and re-reports whatever is still refused.
 */
export function layerLinksKey(streams: StreamList): string {
  return streams
    .filter((s) => s.kind === 'overlay' || s.kind === 'background')
    .map((s) => s.link)
    .join('\n')
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((url, i) => url === b[i])
}

/**
 * The URLs the wall's sessions refused to fetch, oldest first, so an operator
 * standing at the wall learns what happened instead of watching a blank layer
 * (#790).
 *
 * Reports are not matched against the layer's stream list, and no frame is
 * unmounted on their account: the guard reports the request it actually
 * cancelled, which for a redirected link or a refused sub-resource is not the
 * URL the operator typed. Showing what was refused, next to whatever did
 * render, states exactly what is known without guessing at attribution — and
 * leaves a link that was blocked once free to succeed on the next attempt.
 *
 * `resetKey` is what clears the notice. A refused iframe is requested exactly
 * once, so a report can never expire on its own evidence, and the layer page is
 * never reloaded on a config change — new streams are pushed into the live
 * page. Passing a key derived from the layer links means the notice survives
 * until the operator actually changes them, at which point every layer frame is
 * remounted (see `layerLinksKey`'s callers) and anything still refused is
 * reported again. A wall-clock timeout cannot tell "the operator fixed it" from
 * "the operator was not looking".
 *
 * `undefined` means "no state yet" and never clears: the reports the main
 * process replays for the window before the first state arrives would otherwise
 * be thrown away by the very first real key.
 *
 * Reports are buffered and flushed on an interval rather than rendered as they
 * arrive: a page inside a layer can poll a refused endpoint with a
 * cache-busting query string, which would otherwise re-render the whole wall at
 * request rate. Once the buffer is full, further *new* URLs are dropped rather
 * than evicting what is already there, so layer content cannot push the
 * operator's own refused URL out of the notice.
 */
export function useBlockedLayerURLs(
  subscribe: BlockedURLSubscribe,
  resetKey: string | undefined,
): readonly string[] {
  const seen = useRef(new Set<string>())
  const previousKey = useRef<string | undefined>(undefined)
  const [urls, setURLs] = useState<readonly string[]>([])

  useEffect(() => {
    const unsubscribe = subscribe((url) => {
      if (seen.current.size >= MAX_BLOCKED_URLS) {
        return
      }
      seen.current.add(url)
    })

    const flush = setInterval(() => {
      const next = [...seen.current]
      setURLs((previous) => (sameList(previous, next) ? previous : next))
    }, BLOCKED_URL_FLUSH_MS)

    return () => {
      unsubscribe()
      clearInterval(flush)
    }
  }, [subscribe])

  useEffect(() => {
    if (resetKey === undefined) {
      return
    }
    const previous = previousKey.current
    previousKey.current = resetKey
    // Learning the links for the first time is not an operator edit.
    if (previous === undefined || previous === resetKey) {
      return
    }
    seen.current = new Set()
    setURLs([])
  }, [resetKey])

  return urls
}
