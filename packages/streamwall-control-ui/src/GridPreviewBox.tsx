import { type JSX } from 'preact'
import { FaExclamationTriangle, FaPause } from 'react-icons/fa'
import { Color, type ViewPos } from 'streamwall-shared'
import { styled } from 'styled-components'
import { type ColorInstance } from './colorTypes.ts'
import { getHotkeyLabel } from './hotkeyLabel.ts'
import { OrientationIndicator } from './OrientationIndicator.tsx'

const StyledGridInfo = styled.div`
  text-align: center;
  padding: 8px;
  border-radius: 16px;
  pointer-events: none;
  z-index: 1000; /* Keep above grid inputs */
`

const StyledGridPreviewBox = styled.div.attrs<{
  $color: ColorInstance
  $isError: boolean
  $pos: ViewPos
  $windowWidth: number
  $windowHeight: number
  $isListening: boolean
  $borderWidth?: number
}>(() => ({
  $borderWidth: 2,
}))`
  display: flex;
  align-items: center;
  justify-content: center;
  position: absolute;
  background: ${({ $color }) =>
    Color($color).lightness(50).hsl().string() || '#333'};
  border: 0 solid
    ${({ $isError }) =>
      $isError ? Color('red').hsl().string() : Color('black').hsl().string()};
  border-left-width: ${({ $pos, $borderWidth }) =>
    $pos.x === 0 ? 0 : $borderWidth}px;
  border-right-width: ${({ $pos, $borderWidth, $windowWidth }) =>
    $pos.x + $pos.width === $windowWidth ? 0 : $borderWidth}px;
  border-top-width: ${({ $pos, $borderWidth }) =>
    $pos.y === 0 ? 0 : $borderWidth}px;
  border-bottom-width: ${({ $pos, $borderWidth, $windowHeight }) =>
    $pos.y + $pos.height === $windowHeight ? 0 : $borderWidth}px;
  box-shadow: ${({ $isListening }) =>
    $isListening ? `0 0 0 4px red inset` : 'none'};
  box-sizing: border-box;
  overflow: hidden;
  user-select: none;

  ${StyledGridInfo} {
    background: ${({ $color }) =>
      Color($color).lightness(50).hsl().string() || '#333'};
  }
`

const StyledGridLabel = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 30px;

  .orientation-v {
    margin-left: -4px;
  }

  ${StyledGridInfo}.small & {
    font-size: 20px;
  }
`

const StyledGridLocation = styled.div`
  font-size: 13px;
  opacity: 0.75;
`

const StyledGridError = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  margin-top: 6px;
  padding: 3px 8px;
  border-radius: 8px;
  max-width: 100%;
  font-size: 12px;
  font-weight: 600;
  color: white;
  background: ${Color('red').alpha(0.7).string()};

  svg {
    flex-shrink: 0;
  }

  span {
    white-space: nowrap;
    text-overflow: ellipsis;
    overflow: hidden;
  }

  ${StyledGridInfo}.small & {
    span {
      display: none;
    }
  }
`

const StyledGridPaused = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  margin-top: 6px;
  padding: 3px 8px;
  border-radius: 8px;
  max-width: 100%;
  font-size: 12px;
  font-weight: 600;
  color: white;
  background: ${Color('black').alpha(0.55).string()};

  svg {
    flex-shrink: 0;
  }

  ${StyledGridInfo}.small & {
    span {
      display: none;
    }
  }
`

// Extracted from the ControlUI grid preview loop so the error badge markup
// can be rendered and tested in isolation.
export function GridPreviewBox({
  streamId,
  color,
  pos,
  windowWidth,
  windowHeight,
  isListening,
  isSmall,
  isError,
  errorReason,
  isPaused,
  orientation,
  source,
  city,
  state,
  style,
}: {
  streamId: string
  color: ColorInstance
  pos: ViewPos
  windowWidth: number
  windowHeight: number
  isListening: boolean
  isSmall: boolean
  isError: boolean
  errorReason: string | null | undefined
  isPaused: boolean
  orientation: 'V' | 'H' | null | undefined
  source: string | undefined
  city: string | undefined
  state: string | undefined
  style?: JSX.HTMLAttributes['style']
}) {
  const hotkeyLabel = getHotkeyLabel(pos.spaces[0])
  return (
    <StyledGridPreviewBox
      $color={color}
      style={style}
      $pos={pos}
      $windowWidth={windowWidth}
      $windowHeight={windowHeight}
      $isListening={isListening}
      $isError={isError}
      title={hotkeyLabel ? `${hotkeyLabel} toggles audio` : undefined}
    >
      <StyledGridInfo className={isSmall ? 'small' : undefined}>
        <StyledGridLabel>
          {streamId}
          <OrientationIndicator
            orientation={orientation}
            className={`orientation-${(orientation ?? 'unknown').toLowerCase()}`}
          />
        </StyledGridLabel>
        {!isSmall && <div>{source}</div>}
        {city && (
          <StyledGridLocation>
            {city} {state}
          </StyledGridLocation>
        )}
        {isError && (
          <StyledGridError title={errorReason ?? undefined}>
            <FaExclamationTriangle />
            <span>{errorReason ?? 'Stream error'}</span>
          </StyledGridError>
        )}
        {isPaused && (
          <StyledGridPaused
            data-testid="grid-paused-badge"
            title="Playback paused while this view is parked"
          >
            <FaPause />
            <span>Paused</span>
          </StyledGridPaused>
        )}
      </StyledGridInfo>
    </StyledGridPreviewBox>
  )
}
