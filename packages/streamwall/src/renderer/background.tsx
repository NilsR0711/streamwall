import '@fontsource/noto-sans'
import 'streamwall-control-ui/src/index.css'

import { render } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { StreamData } from '../../../streamwall-shared/src/types'
import { StreamwallLayerGlobal } from '../preload/layerPreload'
import { Background } from './BackgroundRoot'
import { initRendererSentry } from './initSentry'
import { useBlockedLayerURLs } from './useBlockedLayerURLs'

declare global {
  interface Window {
    streamwall: StreamwallLayerGlobal
  }
}

initRendererSentry()

const subscribeBlockedURLs = (
  handleBlocked: Parameters<StreamwallLayerGlobal['onBlockedURL']>[0],
) => window.streamwallLayer.onBlockedURL(handleBlocked)

function App() {
  const [streams, setStreams] = useState<StreamData[]>([])
  const blockedURLs = useBlockedLayerURLs(subscribeBlockedURLs)

  useEffect(() => {
    const unsubscribe = window.streamwallLayer.onState(({ streams }) =>
      setStreams(streams),
    )
    window.streamwallLayer.load()
    return unsubscribe
  }, [])

  return <Background streams={streams} blockedURLs={blockedURLs} />
}

render(<App />, document.body)
