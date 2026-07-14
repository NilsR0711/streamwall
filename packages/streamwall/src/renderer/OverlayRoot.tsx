import { useEffect, useState } from 'preact/hooks'
import { StreamwallState, type ViewPos } from 'streamwall-shared'
import { styled } from 'styled-components'
import { matchesState } from 'xstate'
import packageInfo from '../../package.json'
import { LAYER_FRAME_SANDBOX } from './layerFrameSandbox'
import { OverlayViewTile } from './OverlayViewTile'

// Extracted from overlay.tsx so it can be rendered and tested in isolation,
// without pulling in the module-level `render(<App />, document.body)` call.
export function Overlay({
  config,
  views,
  streams,
}: Pick<StreamwallState, 'config' | 'views' | 'streams'>) {
  const { width, height, activeColor } = config
  // Keep error views on the wall (instead of leaving a silent black cell) so the
  // failure and its reason are visible; they are rendered as an error tile below.
  const activeViews = views.filter(({ state }) =>
    matchesState('displaying', state),
  )
  const overlays = streams.filter((s) => s.kind === 'overlay')
  return (
    <OverlayContainer>
      <VersionFooter />
      {activeViews.map(({ state, context }) => {
        const { content, pos } = context
        if (!content || !pos) {
          return
        }

        const data = streams.find((d) => content.url === d.link)
        const isError = matchesState('displaying.error', state)
        const isListening = matchesState(
          'displaying.running.audio.listening',
          state,
        )
        const isBackgroundListening = matchesState(
          'displaying.running.audio.background',
          state,
        )
        const isBlurred = matchesState(
          'displaying.running.video.blurred',
          state,
        )
        const isLoading =
          matchesState('displaying.loading', state) ||
          matchesState('displaying.running.playback.stalled', state)
        return (
          <SpaceBorder
            key={pos.spaces[0]}
            $pos={pos}
            $windowWidth={width}
            $windowHeight={height}
            $activeColor={activeColor}
            $isListening={isListening}
            $isError={isError}
          >
            <OverlayViewTile
              url={content.url}
              data={data}
              isError={isError}
              errorReason={context.error}
              isListening={isListening}
              isBackgroundListening={isBackgroundListening}
              isBlurred={isBlurred}
              isLoading={isLoading}
              activeColor={activeColor}
            />
          </SpaceBorder>
        )
      })}
      {overlays.map((s) => (
        <OverlayIFrame
          key={s._id}
          src={s.link}
          sandbox={LAYER_FRAME_SANDBOX}
          allow="autoplay"
          scrolling="no"
        />
      ))}
    </OverlayContainer>
  )
}

function VersionFooter() {
  const [isShowing, setShowing] = useState(false)
  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | undefined = undefined
    const interval = setInterval(() => {
      setShowing(true)
      timeout = setTimeout(() => {
        setShowing(false)
      }, 5000)
    }, 30 * 1000)
    return () => {
      clearInterval(interval)
      clearTimeout(timeout)
    }
  }, [])
  return (
    <VersionText $isShowing={isShowing}>
      <strong>streamwall</strong> {packageInfo.version}
    </VersionText>
  )
}

const OverlayContainer = styled.div`
  overflow: hidden;
`

const SpaceBorder = styled.div.attrs<{
  $pos: ViewPos
  $windowWidth: number
  $windowHeight: number
  $activeColor: string
  $isListening: boolean
  $isError?: boolean
  $borderWidth?: number
}>(() => ({
  $borderWidth: 2,
}))`
  display: flex;
  align-items: flex-start;
  position: fixed;
  left: ${({ $pos }) => $pos.x}px;
  top: ${({ $pos }) => $pos.y}px;
  width: ${({ $pos }) => $pos.width}px;
  height: ${({ $pos }) => $pos.height}px;
  border: 0 solid ${({ $isError }) => ($isError ? 'red' : 'black')};
  border-left-width: ${({ $pos, $borderWidth }) =>
    $pos.x === 0 ? 0 : $borderWidth}px;
  border-right-width: ${({ $pos, $borderWidth, $windowWidth }) =>
    $pos.x + $pos.width === $windowWidth ? 0 : $borderWidth}px;
  border-top-width: ${({ $pos, $borderWidth }) =>
    $pos.y === 0 ? 0 : $borderWidth}px;
  border-bottom-width: ${({ $pos, $borderWidth, $windowHeight }) =>
    $pos.y + $pos.height === $windowHeight ? 0 : $borderWidth}px;
  box-shadow: ${({ $isListening, $activeColor }) =>
    $isListening ? `0 0 10px ${$activeColor} inset` : 'none'};
  box-sizing: border-box;
  pointer-events: none;
  user-select: none;
`

const VersionText = styled.div<{ $isShowing: boolean }>`
  position: fixed;
  bottom: 4px;
  right: 4px;
  color: white;
  font-size: 12px;
  text-shadow:
    0 0 1px rgba(0, 0, 0, 0.5),
    1px 0 1px rgba(0, 0, 0, 0.5),
    0 1px 1px rgba(0, 0, 0, 0.5),
    1px 1px 1px rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(30px);
  padding: 1px 4px;
  border-bottom-left-radius: 4px;
  opacity: ${({ $isShowing }) => ($isShowing ? '.65' : '.35')};
  transition: ease-out 500ms all;
`

const OverlayIFrame = styled.iframe`
  position: fixed;
  left: 0;
  top: 0;
  width: 100vw;
  height: 100vh;
  border: none;
  pointer-events: none;
`
