import { useCallback, useLayoutEffect, useState } from 'preact/hooks'
import { FaExclamationTriangle } from 'react-icons/fa'
import { MAX_BLOCKED_LAYER_URLS } from 'streamwall-shared'
import { styled } from 'styled-components'

/**
 * Names the overlay/background URLs the wall's hardened layer sessions
 * refused, beside the custom-stream inputs where those links are typed
 * (issue #797).
 *
 * The wall renders the same information for whoever is standing in front of it
 * (#790), which this does not replace: in a control-server deployment the
 * person adding a custom overlay can be on another machine, and for them the
 * layer just silently does nothing.
 *
 * What is shown is the request the guard cancelled, which for a redirect hop
 * or a refused sub-resource is not the link the operator typed -- so the
 * notice states what was refused and why, and never claims a particular stream
 * is broken. The addresses are rendered as plain text: they come from whatever
 * the layer framed, and must not become something an operator can be induced
 * to follow.
 *
 * Dismissal is per address and forgotten once the desktop stops reporting that
 * address, so a later refusal of a different URL, or of the same one after a
 * clear this client saw, is announced again rather than swallowed by an
 * earlier dismissal.
 *
 * A clear this client did not see -- it was disconnected across the operator's
 * edit and reconnected to a snapshot already naming the same address again --
 * is indistinguishable from the address never having gone away by membership
 * alone, which used to leave the new refusal silently suppressed for the life
 * of the page (issue #810). Dismissals are therefore keyed by the clear
 * generation the desktop broadcasts: one made against an older list never
 * applies to a newer one, while a dismissal against the list still standing
 * survives any number of reconnects.
 *
 * The live region itself stays mounted while nothing is refused and only its
 * contents are swapped: `aria-live` announcements are only reliable for
 * changes inside a region that already exists in the accessibility tree
 * (WCAG 4.1.3, issue #463).
 */
export function BlockedLayerURLNotice({
  urls,
  generation,
}: {
  urls: readonly string[]
  /**
   * How often the desktop has cleared its list (issue #810). Dismissals are
   * scoped to the value they were made under, so a clear this client was
   * disconnected across still takes them down.
   */
  generation: number
}) {
  const [dismissed, setDismissed] = useState<{
    generation: number
    urls: readonly string[]
  }>({ generation, urls: [] })

  // A dismissal for an address the desktop no longer reports is forgotten, so
  // the same address being refused again -- after the operator's edit cleared
  // the list, say -- is a new notice rather than one silenced in advance.
  // Layout, not passive: dropping the stale dismissal must not be visible as a
  // flash of the address the operator dismissed.
  useLayoutEffect(() => {
    setDismissed((previous) => {
      // A clear the desktop reports takes every dismissal with it, whether or
      // not this client saw the list go empty in between (issue #810).
      if (previous.generation !== generation) {
        return { generation, urls: [] }
      }
      const next = previous.urls.filter((url) => urls.includes(url))
      return next.length === previous.urls.length
        ? previous
        : { generation, urls: next }
    })
  }, [urls, generation])

  // Read through the generation rather than trusting the state alone: the
  // effect above only runs after this render, and a dismissal from an older
  // list must not suppress anything even for that one pass.
  const activeDismissals =
    dismissed.generation === generation ? dismissed.urls : []
  const visible = urls.filter((url) => !activeDismissals.includes(url))

  const handleDismiss = useCallback(() => {
    setDismissed({ generation, urls })
  }, [urls, generation])

  return (
    <StyledBlockedLayerURLNotice role="status" aria-live="polite">
      {visible.length > 0 && (
        <>
          <div className="blocked-layer-heading">
            <FaExclamationTriangle />
            <span>Blocked: not a public address</span>
            <button type="button" onClick={handleDismiss}>
              Dismiss
            </button>
          </div>
          {visible.map((url) => (
            <div className="blocked-layer-url" key={url}>
              {url}
            </div>
          ))}
          {urls.length >= MAX_BLOCKED_LAYER_URLS && (
            // A property of what the desktop collected, not of what survived
            // dismissal here: once its list is full it stops collecting, so
            // what is listed is not necessarily everything that was refused.
            <div className="blocked-layer-capped">
              The wall stopped collecting after {MAX_BLOCKED_LAYER_URLS} — more
              may have been refused.
            </div>
          )}
        </>
      )}
    </StyledBlockedLayerURLNotice>
  )
}

const StyledBlockedLayerURLNotice = styled.div`
  font-size: 12px;
  color: #e0a800;

  /* Matches the other dismissable banners (CommandErrorBanner). */
  button {
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    font-size: 12px;
    padding: 0;
    text-decoration: underline;
  }
  /* The content is supplied by whatever the layer framed, so it must never be
     able to push the operator's own custom-stream controls out of view. */
  max-height: 8em;
  overflow: auto;

  .blocked-layer-heading {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  /* The addresses come from whatever the layer framed, so a long one has to
     wrap instead of widening the sidebar. */
  .blocked-layer-url,
  .blocked-layer-capped {
    word-break: break-all;
    opacity: 0.8;
  }
`
