import { keyframes, styled } from 'styled-components'
import { type DownloadProgress, type UpdateStatus } from '../updateStatus'

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

const ProgressDetail = styled.span`
  flex-shrink: 0;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
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

const IndeterminateProgressBar = styled.div`
  width: 33%;
  height: 100%;
  border-radius: var(--r-sm);
  background: var(--accent-2);
  animation: ${indeterminate} 1.2s ease-in-out infinite;
`

const DeterminateProgressBar = styled.div`
  height: 100%;
  border-radius: var(--r-sm);
  background: var(--accent-2);
  transition: width 0.3s ease-out;
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
  onDownload: () => void
  onInstall: () => void
  onOpenReleaseNotes: (url: string) => void
  onDismiss: () => void
}

/** 43_515_904 bytes → "41.5 MB", rounded to integers once the number gets wide. */
function formatMegabytes(bytes: number): string {
  const megabytes = bytes / (1024 * 1024)
  return `${megabytes >= 100 ? Math.round(megabytes) : megabytes.toFixed(1)} MB`
}

function Dismiss({ onDismiss }: { onDismiss: () => void }) {
  return (
    <DismissButton
      data-testid="dismiss-update-banner"
      aria-label="Dismiss"
      onClick={onDismiss}
    >
      ×
    </DismissButton>
  )
}

function Progress({ progress }: { progress: DownloadProgress | null }) {
  if (progress === null) {
    return (
      <ProgressTrack role="progressbar" aria-label="Downloading update">
        <IndeterminateProgressBar />
      </ProgressTrack>
    )
  }
  const percent = Math.round(progress.percent)
  return (
    <>
      <ProgressDetail>
        {formatMegabytes(progress.transferred)} of{' '}
        {formatMegabytes(progress.total)} ({percent}%)
      </ProgressDetail>
      <ProgressTrack
        role="progressbar"
        aria-label="Downloading update"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <DeterminateProgressBar style={{ width: `${progress.percent}%` }} />
      </ProgressTrack>
    </>
  )
}

/**
 * In-app update notification (#381), so users no longer have to poll the
 * GitHub Releases page to learn a new version exists.
 *
 * Only the states the user can act on are rendered: `checking` is routine
 * background noise, and a failed check (`error`) is not actionable from here -
 * main/index.ts logs it instead of nagging.
 *
 * `available` announces the update without downloading anything: the download
 * only starts on the Download action (#432), so a full app bundle never
 * competes for bandwidth with a live stream unasked. On Linux
 * (`canDownload: false`, #433) the same state is notify-only - updates go
 * through the package manager, so the only action is opening the release
 * page (see main/linuxUpdateChecker.ts).
 *
 * `downloading` shows byte-level progress once electron-updater reports it,
 * and falls back to an indeterminate indicator until then.
 */
export function UpdateBanner({
  status,
  currentVersion,
  onDownload,
  onInstall,
  onOpenReleaseNotes,
  onDismiss,
}: UpdateBannerProps) {
  if (status.state === 'available' && status.canDownload) {
    return (
      <Banner>
        <Message>
          Streamwall <Version>{status.version}</Version> is available (you're on{' '}
          <Version>{currentVersion}</Version>).
        </Message>
        {status.releaseUrl && (
          <LinkButton
            data-testid="open-release-notes"
            onClick={() => onOpenReleaseNotes(status.releaseUrl!)}
          >
            Release notes
          </LinkButton>
        )}
        <ActionButton data-testid="download-update" onClick={onDownload}>
          Download
        </ActionButton>
        <Dismiss onDismiss={onDismiss} />
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
        {status.releaseUrl && (
          <ActionButton
            data-testid="view-release"
            onClick={() => onOpenReleaseNotes(status.releaseUrl!)}
          >
            View Release
          </ActionButton>
        )}
        <Dismiss onDismiss={onDismiss} />
      </Banner>
    )
  }

  if (status.state === 'downloading') {
    return (
      <Banner>
        <Message>
          Downloading Streamwall <Version>{status.version}</Version>...
        </Message>
        <Progress progress={status.progress} />
        <Dismiss onDismiss={onDismiss} />
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
      <Dismiss onDismiss={onDismiss} />
    </Banner>
  )
}
