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
  viewId,
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
  onToggleFullscreen,
}: {
  // Grid cell index of this tile's top-left space. Used only for position-based
  // operations (swap/drag) that intentionally target the cell, not the view.
  idx: number
  // Stable identity of the view actor currently in this tile. View-state
  // commands (listen/blur/volume/reload/devtools/fullscreen) address the view
  // by this id so a concurrent grid resize can't misroute them (issue #397).
  viewId: number
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
  onSetListening: (viewId: number, isListening: boolean) => void
  onSetBackgroundListening: (
    viewId: number,
    isBackgroundListening: boolean,
  ) => void
  onSetBlurred: (viewId: number, isBlurred: boolean) => void
  onSetVolume: (viewId: number, volume: number) => void
  onReloadView: (viewId: number) => void
  onSwapView: (idx: number) => void
  onRotateView: (streamId: string) => void
  onBrowse: (streamId: string) => void
  onDevTools: (viewId: number) => void
  onPointerDown: JSX.PointerEventHandler<HTMLDivElement>
  onToggleFullscreen: (viewId: number) => void
}) {
  const handleListeningClick = useCallback<
    JSX.MouseEventHandler<HTMLButtonElement>
  >(
    (ev) =>
      ev.shiftKey || isBackgroundListening
        ? onSetBackgroundListening(viewId, !isBackgroundListening)
        : onSetListening(viewId, !isListening),
    [
      viewId,
      onSetListening,
      onSetBackgroundListening,
      isListening,
      isBackgroundListening,
    ],
  )
  const handleBlurClick = useCallback(
    () => onSetBlurred(viewId, !isBlurred),
    [viewId, onSetBlurred, isBlurred],
  )
  const handleVolumeInput = useCallback<
    JSX.InputEventHandler<HTMLInputElement>
  >(
    (ev) => onSetVolume(viewId, Number(ev.currentTarget.value)),
    [viewId, onSetVolume],
  )
  const handleReloadClick = useCallback(
    () => onReloadView(viewId),
    [viewId, onReloadView],
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
    () => onDevTools(viewId),
    [viewId, onDevTools],
  )
  const handleDoubleClick = useCallback<JSX.MouseEventHandler<HTMLDivElement>>(
    (ev) => {
      if (!roleCan(role, 'set-view-fullscreen')) {
        return
      }
      // Ignore double-clicks that land on the corner controls (buttons/sliders)
      // so toggling blur/volume/etc. never doubles as a fullscreen toggle; only
      // the open area of the tile expands it.
      if (ev.target instanceof Element && ev.target.closest('button, input')) {
        return
      }
      onToggleFullscreen(viewId)
    },
    [role, viewId, onToggleFullscreen],
  )
  return (
    <StyledGridControlsContainer
      style={style}
      onPointerDown={onPointerDown}
      onDblClick={handleDoubleClick}
      data-testid="grid-controls"
      data-idx={idx}
    >
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
