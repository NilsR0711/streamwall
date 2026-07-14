import { render } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { useHotkeys } from 'react-hotkeys-hook'
import { StreamwallState } from 'streamwall-shared'
import { StreamwallLayerGlobal } from '../preload/layerPreload'
import { initRendererSentry } from './initSentry'
import { Overlay } from './OverlayRoot'

import '@fontsource/noto-sans'
import 'streamwall-control-ui/src/index.css'

declare global {
  interface Window {
    streamwallLayer: StreamwallLayerGlobal
  }
}

initRendererSentry()

function App() {
  const [state, setState] = useState<StreamwallState | undefined>()

  useEffect(() => {
    const unsubscribe = window.streamwallLayer.onState(setState)
    window.streamwallLayer.load()
    return unsubscribe
  }, [])

  useHotkeys('ctrl+shift+i', () => {
    window.streamwallLayer.openDevTools()
  })

  if (!state) {
    return
  }

  const { config, views, streams } = state
  return <Overlay config={config} views={views} streams={streams} />
}

render(<App />, document.body)
