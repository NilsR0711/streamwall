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
 * Dismissal is per address, so a later refusal of a different URL -- or of the
 * same one after the desktop cleared the list on the operator's edit -- is
 * announced again rather than swallowed by an earlier dismissal.
 *
 * The live region itself stays mounted while nothing is refused and only its
 * contents are swapped: `aria-live` announcements are only reliable for
 * changes inside a region that already exists in the accessibility tree
 * (WCAG 4.1.3, issue #463).
 */
export function BlockedLayerURLNotice({ urls }: { urls: readonly string[] }) {
  const [dismissed, setDismissed] = useState<readonly string[]>([])

  // A dismissal for an address the desktop no longer reports is forgotten, so
  // the same address being refused again -- after the operator's edit cleared
  // the list, say -- is a new notice rather than one silenced in advance.
  // Layout, not passive: dropping the stale dismissal must not be visible as a
  // flash of the address the operator dismissed.
  useLayoutEffect(() => {
    setDismissed((previous) => {
      const next = previous.filter((url) => urls.includes(url))
      return next.length === previous.length ? previous : next
    })
  }, [urls])

  const visible = urls.filter((url) => !dismissed.includes(url))

  const handleDismiss = useCallback(() => {
    setDismissed(urls)
  }, [urls])

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
