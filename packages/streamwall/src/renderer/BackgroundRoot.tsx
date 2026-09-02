import { StreamList } from 'streamwall-shared'
import { styled } from 'styled-components'
import { BlockedLayerNotice } from './BlockedLayerNotice'
import { LAYER_FRAME_SANDBOX } from './layerFrameSandbox'

// Extracted from background.tsx so it can be rendered and tested in isolation,
// without pulling in the module-level `render(<App />, document.body)` call --
// the same split OverlayRoot.tsx makes for the overlay layer.
export function Background({
  streams,
  blockedURLs = new Map(),
}: {
  streams: StreamList
  /** URLs the session refused to fetch, keyed by URL, with the reason (#790). */
  blockedURLs?: ReadonlyMap<string, string>
}) {
  const backgrounds = streams.filter((s) => s.kind === 'background')
  return (
    <div>
      {backgrounds.map((s) => {
        // A blocked URL would otherwise leave an iframe that never paints, with
        // nothing on the wall to say why (#790).
        const blockedReason = blockedURLs.get(s.link)
        if (blockedReason !== undefined) {
          return (
            <BlockedBackgroundNotice key={s._id}>
              <BlockedLayerNotice url={s.link} reason={blockedReason} />
            </BlockedBackgroundNotice>
          )
        }
        return (
          <BackgroundIFrame
            key={s._id}
            src={s.link}
            sandbox={LAYER_FRAME_SANDBOX}
            allow="autoplay"
            scrolling="no"
          />
        )
      })}
    </div>
  )
}

// Sits over the background layer so a failed background is visible on the wall
// instead of an empty frame.
const BlockedBackgroundNotice = styled.div`
  position: fixed;
  left: 1em;
  top: 1em;
  max-width: 40vw;
`

const BackgroundIFrame = styled.iframe`
  position: fixed;
  left: 0;
  top: 0;
  width: 100vw;
  height: 100vh;
  border: none;
`
