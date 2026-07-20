import { keyframes, styled } from 'styled-components'
import { type UpdateStatus } from '../updateStatus'

const Banner = styled.div`
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  background: var(--surface-2);
  border-bottom: 1px solid var(--border);
  color: var(--text);
  font-family: var(--font-ui);
  font-size: 13px;
`

const Message = styled.div`
  flex: 1;
  min-width: 0;
`

const Version = styled.code`
  font-family: var(--font-mono);
  background: var(--surface-3);
  border-radius: var(--r-sm);
  padding: 1px 5px;
`

const indeterminate = keyframes`
  from { transform: translateX(-100%); }
  to { transform: translateX(300%); }
`

const ProgressTrack = styled.div`
  flex-shrink: 0;
  width: 96px;
  height: 4px;
  border-radius: var(--r-sm);
  background: var(--surface-3);
  overflow: hidden;
`

const ProgressBar = styled.div`
  width: 33%;
  height: 100%;
  border-radius: var(--r-sm);
  background: var(--accent-2);
  animation: ${indeterminate} 1.2s ease-in-out infinite;
`

const ActionButton = styled.button`
  flex-shrink: 0;
  background: var(--accent-2);
  color: var(--surface);
  border: none;
  border-radius: var(--r-sm);
  padding: 6px 10px;
  font-family: var(--font-ui);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
`

const LinkButton = styled.button`
  flex-shrink: 0;
  background: none;
  border: none;
  color: var(--accent-2);
  font-family: var(--font-ui);
  font-size: 13px;
  text-decoration: underline;
  cursor: pointer;
  padding: 6px 2px;
`

const DismissButton = styled.button`
  flex-shrink: 0;
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  padding: 4px;
`

export interface UpdateBannerProps {
  status: UpdateStatus
  currentVersion: string
  onInstall: () => void
  onOpenReleaseNotes: (url: string) => void
  onDismiss: () => void
}

/**
 * In-app update notification (#381), so users no longer have to poll the
 * GitHub Releases page to learn a new version exists.
 *
 * Only the states the user can act on are rendered: `checking` is routine
 * background noise, and a failed check (`error`) is not actionable from here -
 * main/index.ts logs it instead of nagging.
 *
 * The download indicator is deliberately indeterminate: Electron's Squirrel
 * autoUpdater emits no byte-level progress (see main/appUpdater.ts), so a
 * percentage would have to be invented.
 *
 * `available` (#433) is Linux's notify-only counterpart to `ready`: Squirrel
 * cannot download or install there, so the only action offered is opening the
 * release page - see main/linuxUpdateChecker.ts.
 */
export function UpdateBanner({
  status,
  currentVersion,
  onInstall,
  onOpenReleaseNotes,
  onDismiss,
}: UpdateBannerProps) {
  if (status.state === 'downloading') {
    return (
      <Banner>
        <Message>Downloading a new version of Streamwall...</Message>
        <ProgressTrack role="progressbar" aria-label="Downloading update">
          <ProgressBar />
        </ProgressTrack>
        <DismissButton
          data-testid="dismiss-update-banner"
          aria-label="Dismiss"
          onClick={onDismiss}
        >
          ×
        </DismissButton>
      </Banner>
    )
  }

  if (status.state === 'available') {
    return (
      <Banner>
        <Message>
          Streamwall <Version>{status.version}</Version> is available (you're on{' '}
          <Version>{currentVersion}</Version>). Update via your package manager,
          or view the release.
        </Message>
        <ActionButton
          data-testid="view-release"
          onClick={() => onOpenReleaseNotes(status.releaseUrl)}
        >
          View Release
        </ActionButton>
        <DismissButton
          data-testid="dismiss-update-banner"
          aria-label="Dismiss"
          onClick={onDismiss}
        >
          ×
        </DismissButton>
      </Banner>
    )
  }

  if (status.state !== 'ready') {
    return null
  }

  return (
    <Banner>
      <Message>
        Streamwall <Version>{status.version}</Version> is ready to install
        (you're on <Version>{currentVersion}</Version>).
      </Message>
      {status.releaseNotesUrl && (
        <LinkButton
          data-testid="open-release-notes"
          onClick={() => onOpenReleaseNotes(status.releaseNotesUrl!)}
        >
          Release notes
        </LinkButton>
      )}
      <ActionButton data-testid="install-update" onClick={onInstall}>
        Restart &amp; Install
      </ActionButton>
      <DismissButton
        data-testid="dismiss-update-banner"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        ×
      </DismissButton>
    </Banner>
  )
}
