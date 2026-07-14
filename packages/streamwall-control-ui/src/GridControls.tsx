import { type JSX } from 'preact'
import { useCallback } from 'preact/hooks'
import {
  FaExchangeAlt,
  FaRedoAlt,
  FaRegLifeRing,
  FaRegWindowMaximize,
  FaSyncAlt,
  FaVideoSlash,
  FaVolumeUp,
} from 'react-icons/fa'
import { Color, roleCan, type StreamwallRole } from 'streamwall-shared'
import { styled } from 'styled-components'
import {
  StyledButton,
  StyledSmallButton,
  StyledVolumeSlider,
} from './StyledButton.tsx'

const StyledGridButtons = styled.div<{ $side?: 'left' | 'right' }>`
  display: flex;
  position: absolute;
  ${({ $side }) =>
    $side === 'left' ? 'top: 0; left: 0' : 'bottom: 0; right: 0'};

  ${StyledButton} {
    margin: 5px;
    ${({ $side }) => ($side === 'left' ? 'margin-right: 0' : 'margin-left: 0')};
  }
`

const StyledGridControlsContainer = styled.div`
  position: absolute;
  user-select: none;
  touch-action: none;

  & > * {
    z-index: 1001; // Above StyledGridInfo
  }
`

export function GridControls({
  idx,
  streamId,
  style,
  isDisplaying,
  isListening,
  isBackgroundListening,
  isBlurred,
  volume,
  isSwapping,
  showDebug,
  role,
  onSetListening,
  onSetBackgroundListening,
  onSetBlurred,
  onSetVolume,
  onReloadView,
  onSwapView,
  onRotateView,
  onBrowse,
  onDevTools,
  onPointerDown,
}: {
  idx: number
  streamId: string
  style: JSX.HTMLAttributes['style']
  isDisplaying: boolean
  isListening: boolean
  isBackgroundListening: boolean
  isBlurred: boolean
  volume: number
  isSwapping: boolean
  showDebug: boolean
  role: StreamwallRole | null
  onSetListening: (idx: number, isListening: boolean) => void
  onSetBackgroundListening: (
    idx: number,
    isBackgroundListening: boolean,
  ) => void
  onSetBlurred: (idx: number, isBlurred: boolean) => void
  onSetVolume: (idx: number, volume: number) => void
  onReloadView: (idx: number) => void
  onSwapView: (idx: number) => void
  onRotateView: (streamId: string) => void
  onBrowse: (streamId: string) => void
  onDevTools: (idx: number) => void
  onPointerDown: JSX.PointerEventHandler<HTMLDivElement>
}) {
  // TODO: Refactor callbacks to use streamID instead of idx.
  // We should probably also switch the view-state-changing RPCs to use a view id instead of idx like they do currently.
  const handleListeningClick = useCallback<
    JSX.MouseEventHandler<HTMLButtonElement>
  >(
    (ev) =>
      ev.shiftKey || isBackgroundListening
        ? onSetBackgroundListening(idx, !isBackgroundListening)
        : onSetListening(idx, !isListening),
    [
      idx,
      onSetListening,
      onSetBackgroundListening,
      isListening,
      isBackgroundListening,
    ],
  )
  const handleBlurClick = useCallback(
    () => onSetBlurred(idx, !isBlurred),
    [idx, onSetBlurred, isBlurred],
  )
  const handleVolumeInput = useCallback<
    JSX.InputEventHandler<HTMLInputElement>
  >(
    (ev) => onSetVolume(idx, Number(ev.currentTarget.value)),
    [idx, onSetVolume],
  )
  const handleReloadClick = useCallback(
    () => onReloadView(idx),
    [idx, onReloadView],
  )
  const handleSwapClick = useCallback(() => onSwapView(idx), [idx, onSwapView])
  const handleRotateClick = useCallback(
    () => onRotateView(streamId),
    [streamId, onRotateView],
  )
  const handleBrowseClick = useCallback(
    () => onBrowse(streamId),
    [streamId, onBrowse],
  )
  const handleDevToolsClick = useCallback(
    () => onDevTools(idx),
    [idx, onDevTools],
  )
  return (
    <StyledGridControlsContainer style={style} onPointerDown={onPointerDown}>
      {isDisplaying && (
        <StyledGridButtons $side="left">
          {showDebug ? (
            <>
              {roleCan(role, 'reload-view') && (
                <StyledSmallButton
                  onClick={handleReloadClick}
                  aria-label="Reload stream"
                >
                  <FaSyncAlt />
                </StyledSmallButton>
              )}
              {roleCan(role, 'browse') && (
                <StyledSmallButton
                  onClick={handleBrowseClick}
                  aria-label="Open stream in browser"
                >
                  <FaRegWindowMaximize />
                </StyledSmallButton>
              )}
              {roleCan(role, 'dev-tools') && (
                <StyledSmallButton
                  onClick={handleDevToolsClick}
                  aria-label="Open developer tools"
                >
                  <FaRegLifeRing />
                </StyledSmallButton>
              )}
            </>
          ) : (
            <>
              {roleCan(role, 'reload-view') && (
                <StyledSmallButton
                  onClick={handleReloadClick}
                  aria-label="Reload stream"
                >
                  <FaSyncAlt />
                </StyledSmallButton>
              )}
              {roleCan(role, 'mutate-state-doc') && (
                <StyledSmallButton
                  $isActive={isSwapping}
                  onClick={handleSwapClick}
                  aria-label={isSwapping ? 'Cancel swap' : 'Swap stream'}
                >
                  <FaExchangeAlt />
                </StyledSmallButton>
              )}
              {roleCan(role, 'rotate-stream') && (
                <StyledSmallButton
                  onClick={handleRotateClick}
                  aria-label="Rotate stream"
                >
                  <FaRedoAlt />
                </StyledSmallButton>
              )}
            </>
          )}
        </StyledGridButtons>
      )}
      <StyledGridButtons $side="right">
        {roleCan(role, 'set-view-blurred') && (
          <StyledButton
            $isActive={isBlurred}
            onClick={handleBlurClick}
            aria-label={isBlurred ? 'Unblur video' : 'Blur video'}
          >
            <FaVideoSlash />
          </StyledButton>
        )}
        {roleCan(role, 'set-view-volume') && (
          <StyledVolumeSlider
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onInput={handleVolumeInput}
            aria-label="Volume"
          />
        )}
        {roleCan(role, 'set-listening-view') && (
          <StyledButton
            $isActive={isListening || isBackgroundListening}
            $activeColor={
              isListening ? 'red' : Color('red').desaturate(0.5).hsl().string()
            }
            onClick={handleListeningClick}
            aria-label={
              isListening || isBackgroundListening
                ? 'Mute audio'
                : 'Listen to audio'
            }
          >
            <FaVolumeUp />
          </StyledButton>
        )}
      </StyledGridButtons>
    </StyledGridControlsContainer>
  )
}
