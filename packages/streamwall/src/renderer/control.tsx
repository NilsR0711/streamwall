import { render } from 'preact'
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks'
import { useHotkeys } from 'react-hotkeys-hook'
import {
  ControlUI,
  GlobalStyle,
  StreamwallConnection,
  useCollabConnection,
} from 'streamwall-control-ui'
import {
  FirstRunInfo,
  StreamwallControlGlobal,
} from '../preload/controlPreload'
import { type UpdateStatus } from '../updateStatus'
import { FirstRunHint } from './FirstRunHint'
import { initRendererSentry } from './initSentry'
import { createIpcCollabTransport } from './ipcCollabTransport'
import { UpdateBanner } from './UpdateBanner'

const DISMISSED_STORAGE_KEY = 'streamwall:first-run-hint-dismissed'

declare global {
  interface Window {
    streamwallControl: StreamwallControlGlobal
  }
}

initRendererSentry()

function useStreamwallIPCConnection(): StreamwallConnection {
  const transport = useMemo(
    () => createIpcCollabTransport(window.streamwallControl),
    [],
  )
  return useCollabConnection(transport)
}

/**
 * Surfaces the first-run hint until the user either has a userData
 * config.toml or explicitly dismisses it (persisted across restarts, since
 * a config-less setup - e.g. one driven entirely by CLI flags - is valid and
 * shouldn't nag every launch).
 */
function useFirstRunHint() {
  const [firstRunInfo, setFirstRunInfo] = useState<FirstRunInfo>()
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(DISMISSED_STORAGE_KEY) === 'true',
  )

  useEffect(() => {
    window.streamwallControl.getFirstRunInfo().then(setFirstRunInfo)
  }, [])

  const dismiss = useCallback(() => {
    localStorage.setItem(DISMISSED_STORAGE_KEY, 'true')
    setDismissed(true)
  }, [])

  return {
    isVisible: Boolean(
      firstRunInfo && !firstRunInfo.hasUserConfig && !dismissed,
    ),
    configPath: firstRunInfo?.configPath,
    dismiss,
  }
}

/**
 * Tracks the main-process updater (#381). Pulls the current status once on
 * mount (the updater may already have moved past `idle` before the renderer
 * existed) and follows transitions from there.
 *
 * Dismissal is keyed on the version rather than a plain boolean, so dismissing
 * one update does not hide the next one - and is deliberately not persisted:
 * a downloaded update is worth re-offering after a restart.
 */
function useUpdateStatus() {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' })
  const [appVersion, setAppVersion] = useState('')
  const [dismissedVersion, setDismissedVersion] = useState<string>()

  useEffect(() => {
    window.streamwallControl.getUpdateStatus().then(setStatus)
    window.streamwallControl.getAppVersion().then(setAppVersion)
    return window.streamwallControl.onUpdateStatus(setStatus)
  }, [])

  // Keyed on state *and* version: dismissing the "downloading" notice for a
  // version must not also swallow its later "ready to install" notice.
  const dismissKey =
    'version' in status ? `${status.state}:${status.version}` : 'pending'

  const dismiss = useCallback(() => {
    setDismissedVersion(dismissKey)
  }, [dismissKey])

  const isDismissed = dismissedVersion === dismissKey

  return {
    status: isDismissed ? ({ state: 'idle' } as const) : status,
    appVersion,
    dismiss,
  }
}

function App() {
  const connection = useStreamwallIPCConnection()
  const firstRunHint = useFirstRunHint()
  const update = useUpdateStatus()

  useHotkeys('ctrl+shift+i', () => {
    window.streamwallControl.openDevTools()
  })

  return (
    <>
      <GlobalStyle />
      <UpdateBanner
        status={update.status}
        currentVersion={update.appVersion}
        onDownload={() => window.streamwallControl.downloadUpdate()}
        onInstall={() => window.streamwallControl.installUpdate()}
        onOpenReleaseNotes={() => window.streamwallControl.openReleaseNotes()}
        onDismiss={update.dismiss}
      />
      {firstRunHint.isVisible && (
        <FirstRunHint
          configPath={firstRunHint.configPath!}
          onOpenConfigFolder={() => window.streamwallControl.openConfigFolder()}
          onCreateExampleConfig={() =>
            window.streamwallControl.createExampleConfig()
          }
          onDismiss={firstRunHint.dismiss}
        />
      )}
      <ControlUI connection={connection} />
    </>
  )
}

render(<App />, document.body)
