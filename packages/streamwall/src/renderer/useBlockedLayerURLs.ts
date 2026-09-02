import { useEffect, useState } from 'preact/hooks'

/** Subscribes to the layer's blocked-URL reports; returns an unsubscribe. */
export type BlockedURLSubscribe = (
  handleBlocked: (url: string) => void,
) => () => void

/**
 * How many blocked URLs a layer will show at once. A page inside a layer can
 * poll a refused endpoint with a cache-busting query string, which would
 * otherwise grow this list — and the re-render it causes — without bound.
 */
export const MAX_BLOCKED_URLS = 5

/**
 * The URLs this layer's session most recently refused to fetch, oldest first,
 * so the layer can say what happened instead of just going blank (#790).
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
  const [blocked, setBlocked] = useState<readonly string[]>([])

  useEffect(() => {
    return subscribe((url) => {
      setBlocked((previous) => {
        // A URL refused again is not news; keep it where it is rather than
        // re-rendering to move it to the end.
        if (previous.includes(url)) {
          return previous
        }
        return [...previous, url].slice(-MAX_BLOCKED_URLS)
      })
    })
  }, [subscribe])

  return blocked
}
