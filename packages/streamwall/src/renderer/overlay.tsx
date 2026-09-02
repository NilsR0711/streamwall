import { render } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { useHotkeys } from 'react-hotkeys-hook'
import { StreamwallState } from 'streamwall-shared'
import { StreamwallLayerGlobal } from '../preload/layerPreload'
import { initRendererSentry } from './initSentry'
import { Overlay } from './OverlayRoot'
import { layerLinksKey, useBlockedLayerURLs } from './useBlockedLayerURLs'

import '@fontsource/noto-sans'
import 'streamwall-control-ui/src/index.css'

declare global {
  interface Window {
    streamwallLayer: StreamwallLayerGlobal
  }
}

initRendererSentry()

const subscribeBlockedURLs = (handleBlocked: (url: string) => void) =>
  window.streamwallLayer.onBlockedURL(handleBlocked)

function App() {
  const [state, setState] = useState<StreamwallState | undefined>()
  // Both layers report here (the overlay is the only child the wall's tiles are
  // never stacked over), so the notice clears when either layer's links change.
  const blockedURLs = useBlockedLayerURLs(
    subscribeBlockedURLs,
    state && layerLinksKey(state.streams),
  )

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
  return (
    <Overlay
      config={config}
      views={views}
      streams={streams}
      blockedURLs={blockedURLs}
    />
  )
}

render(<App />, document.body)
