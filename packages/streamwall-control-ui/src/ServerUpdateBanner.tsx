import { useState } from 'preact/hooks'
import { styled } from 'styled-components'
import { type ServerStatus } from './useServerStatus.ts'

const StyledServerUpdateBanner = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-dim);

  .server-update-banner {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  a {
    color: inherit;
  }

  button {
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    font-size: 12px;
    padding: 0;
    text-decoration: underline;
  }
`

const DISMISSED_STORAGE_KEY = 'streamwall:update-notice-dismissed-release'

function readDismissedKey(): string | null {
  try {
    return localStorage.getItem(DISMISSED_STORAGE_KEY)
  } catch {
    return null
  }
}

/**
 * Dismissible "a newer release is available" notice for admins, sourced
 * from `GET /admin/status` (#436). Dismissal is keyed on `latestVersion` so
 * dismissing one release doesn't hide the next one.
 *
 * The live region itself stays mounted while there is no update and only its
 * contents are swapped: `aria-live` announcements are only reliable for
 * changes inside a region that already exists in the accessibility tree, so
 * mounting the region together with the notice risks losing exactly that
 * announcement - and the notice appears without any user action, once
 * `GET /admin/status` resolves (WCAG 4.1.3, issue #502). The
 * `server-update-banner` class therefore sits on the notice, which is still
 * present only while an update is pending.
 */
export function ServerUpdateBanner({
  status,
}: {
  status: ServerStatus | null
}) {
  const releaseKey = status?.latestVersion ?? status?.version ?? null
  const [dismissedKey, setDismissedKey] = useState(readDismissedKey)

  function handleDismiss(releaseToDismiss: string) {
    setDismissedKey(releaseToDismiss)
    try {
      localStorage.setItem(DISMISSED_STORAGE_KEY, releaseToDismiss)
    } catch {
      // ignore (e.g. storage disabled)
    }
  }

  const hasUpdate =
    status != null &&
    releaseKey != null &&
    status.checkEnabled &&
    status.updateAvailable &&
    dismissedKey !== releaseKey

  return (
    <StyledServerUpdateBanner role="status" aria-live="polite">
      {hasUpdate && (
        <span className="server-update-banner">
          <span>
            A Streamwall update is available: {status.latestVersion} (you're on{' '}
            {status.version}).
          </span>
          {status.releaseUrl && (
            <a href={status.releaseUrl} target="_blank" rel="noreferrer">
              Release notes
            </a>
          )}
          <button type="button" onClick={() => handleDismiss(releaseKey)}>
            Dismiss
          </button>
        </span>
      )}
    </StyledServerUpdateBanner>
  )
}
