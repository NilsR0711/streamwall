import { useEffect, useState } from 'preact/hooks'
import type { BlockedLayerURL } from '../preload/layerPreload'

/** Subscribes to the layer's blocked-URL reports; returns an unsubscribe. */
export type BlockedURLSubscribe = (
  handleBlocked: (blocked: BlockedLayerURL) => void,
) => () => void

/**
 * Collects the URLs this layer's session refused to fetch, keyed by URL with
 * the reason as the value, so a layer can render the failure instead of a blank
 * frame (#790).
 *
 * Reports accumulate rather than replace: the guard reports one request at a
 * time, and a layer may be showing several frames. A URL that stops being
 * blocked (the operator fixes the address, or the stream list drops it) simply
 * stops being looked up.
 */
export function useBlockedLayerURLs(
  subscribe: BlockedURLSubscribe,
): ReadonlyMap<string, string> {
  const [blocked, setBlocked] = useState<ReadonlyMap<string, string>>(new Map())

  useEffect(() => {
    return subscribe(({ url, reason }) => {
      setBlocked((previous) => {
        if (previous.get(url) === reason) {
          return previous
        }
        return new Map(previous).set(url, reason)
      })
    })
  }, [subscribe])

  return blocked
}
