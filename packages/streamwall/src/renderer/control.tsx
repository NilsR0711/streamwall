import { render } from 'preact'
import { useCallback, useEffect, useState } from 'preact/hooks'
import { useHotkeys } from 'react-hotkeys-hook'
import {
  CollabData,
  ControlUI,
  GlobalStyle,
  StreamwallConnection,
  useStreamwallState,
  useYDoc,
} from 'streamwall-control-ui'
import { ControlCommand, StreamwallState } from 'streamwall-shared'
import * as Y from 'yjs'
import {
  FirstRunInfo,
  StreamwallControlGlobal,
} from '../preload/controlPreload'
import { FirstRunHint } from './FirstRunHint'
import { initRendererSentry } from './initSentry'

const DISMISSED_STORAGE_KEY = 'streamwall:first-run-hint-dismissed'

declare global {
  interface Window {
    streamwallControl: StreamwallControlGlobal
  }
}

initRendererSentry()

function useStreamwallIPCConnection(): StreamwallConnection {
  const {
    docValue: sharedState,
    doc: stateDoc,
    undoManager,
  } = useYDoc<CollabData>(['views'], 'app')

  const [streamwallState, setStreamwallState] = useState<StreamwallState>()
  const appState = useStreamwallState(streamwallState)

  useEffect(() => {
    // TODO: improve typing (Zod?)
    function handleState(state: StreamwallState) {
      setStreamwallState(state)
    }
    return window.streamwallControl.onState(handleState)
  }, [])

  const send = useCallback(
    async (msg: ControlCommand, cb?: (msg: unknown) => void) => {
      const resp = await window.streamwallControl.invokeCommand(msg)
      cb?.(resp)
    },
    [],
  )

  useEffect(() => {
    function sendUpdate(update: Uint8Array, origin: string) {
      if (origin === 'app') {
        return
      }
      window.streamwallControl.updateYDoc(update)
    }

    function handleUpdate(update: Uint8Array) {
      Y.applyUpdate(stateDoc, update, 'app')
    }

    stateDoc.on('update', sendUpdate)
    const unsubscribeUpdate = window.streamwallControl.onYDoc(handleUpdate)
    return () => {
      stateDoc.off('update', sendUpdate)
      unsubscribeUpdate()
    }
  }, [stateDoc])

  useEffect(() => {
    window.streamwallControl.load()
  }, [])

  return {
    ...appState,
    isConnected: true,
    send,
    sharedState,
    stateDoc,
    undoManager,
  }
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

function App() {
  const connection = useStreamwallIPCConnection()
  const firstRunHint = useFirstRunHint()

  useHotkeys('ctrl+shift+i', () => {
    window.streamwallControl.openDevTools()
  })

  return (
    <>
      <GlobalStyle />
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
