import '@fontsource/noto-sans'
import 'streamwall-control-ui/src/index.css'

import { render } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { styled } from 'styled-components'
import { StreamData, StreamList } from '../../../streamwall-shared/src/types'
import { StreamwallLayerGlobal } from '../preload/layerPreload'
import { initRendererSentry } from './initSentry'
import { LAYER_FRAME_SANDBOX } from './layerFrameSandbox'
import { layerLinksKey } from './useBlockedLayerURLs'

declare global {
  interface Window {
    streamwall: StreamwallLayerGlobal
  }
}

initRendererSentry()

function Background({ streams }: { streams: StreamList }) {
  const backgrounds = streams.filter((s) => s.kind === 'background')
  const linksKey = layerLinksKey(streams)
  return (
    <div>
      {backgrounds.map((s) => (
        <BackgroundIFrame
          // Remounted whenever any layer link is edited, not just this one's:
          // a refused frame is requested exactly once, so a layer that is still
          // blocked has to be re-requested to report itself again once the
          // overlay's notice has been cleared (#790).
          key={`${linksKey}:${s._id}`}
          src={s.link}
          sandbox={LAYER_FRAME_SANDBOX}
          allow="autoplay"
          scrolling="no"
        />
      ))}
    </div>
  )
}

function App() {
  const [streams, setStreams] = useState<StreamData[]>([])

  useEffect(() => {
    const unsubscribe = window.streamwallLayer.onState(({ streams }) =>
      setStreams(streams),
    )
    window.streamwallLayer.load()
    return unsubscribe
  }, [])

  return <Background streams={streams} />
}

const BackgroundIFrame = styled.iframe`
  position: fixed;
  left: 0;
  top: 0;
  width: 100vw;
  height: 100vh;
  border: none;
`

render(<App />, document.body)
