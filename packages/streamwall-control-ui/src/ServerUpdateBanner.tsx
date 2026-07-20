import { useState } from 'preact/hooks'
import { styled } from 'styled-components'
import { type ServerStatus } from './useServerStatus.ts'

const StyledServerUpdateBanner = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-dim);

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
 */
export function ServerUpdateBanner({
  status,
}: {
  status: ServerStatus | null
}) {
  const releaseKey = status?.latestVersion ?? status?.version ?? null
  const [dismissedKey, setDismissedKey] = useState(readDismissedKey)

  if (
    status == null ||
    !status.checkEnabled ||
    !status.updateAvailable ||
    releaseKey == null ||
    dismissedKey === releaseKey
  ) {
    return null
  }
  // Reassign into a freshly-typed `const` (`string`, not `string | null`):
  // TypeScript doesn't carry the `releaseKey == null` narrowing above into
  // the nested `handleDismiss` closure.
  const confirmedReleaseKey: string = releaseKey

  function handleDismiss() {
    setDismissedKey(confirmedReleaseKey)
    try {
      localStorage.setItem(DISMISSED_STORAGE_KEY, confirmedReleaseKey)
    } catch {
      // ignore (e.g. storage disabled)
    }
  }

  return (
    <StyledServerUpdateBanner className="server-update-banner">
      <span>
        A Streamwall update is available: {status.latestVersion} (you're on{' '}
        {status.version}).
      </span>
      {status.releaseUrl && (
        <a href={status.releaseUrl} target="_blank" rel="noreferrer">
          Release notes
        </a>
      )}
      <button type="button" onClick={handleDismiss}>
        Dismiss
      </button>
    </StyledServerUpdateBanner>
  )
}
