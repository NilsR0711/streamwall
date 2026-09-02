import { StreamList } from 'streamwall-shared'
import { styled } from 'styled-components'
import { BlockedLayerNotices } from './BlockedLayerNotice'
import { LAYER_FRAME_SANDBOX } from './layerFrameSandbox'

// Extracted from background.tsx so it can be rendered and tested in isolation,
// without pulling in the module-level `render(<App />, document.body)` call --
// the same split OverlayRoot.tsx makes for the overlay layer.
export function Background({
  streams,
  blockedURLs = [],
}: {
  streams: StreamList
  /** URLs this layer's session refused to fetch (#790). */
  blockedURLs?: readonly string[]
}) {
  const backgrounds = streams.filter((s) => s.kind === 'background')
  return (
    <div>
      {backgrounds.map((s) => (
        <BackgroundIFrame
          key={s._id}
          src={s.link}
          sandbox={LAYER_FRAME_SANDBOX}
          allow="autoplay"
          scrolling="no"
        />
      ))}
      <BlockedLayerNotices urls={blockedURLs} />
    </div>
  )
}

const BackgroundIFrame = styled.iframe`
  position: fixed;
  left: 0;
  top: 0;
  width: 100vw;
  height: 100vh;
  border: none;
`
