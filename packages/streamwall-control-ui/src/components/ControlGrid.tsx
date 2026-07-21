import { range } from 'lodash-es'
import {
  idColor,
  type StreamData,
  type StreamwallRole,
} from 'streamwall-shared'
import { styled } from 'styled-components'
import { matchesState } from 'xstate'
import { type CollabData } from '../collabData.ts'
import { GridControls } from '../GridControls.tsx'
import { GridInput } from '../GridInput.tsx'
import { isIdxInResizeBox } from '../gridInteractions'
import { GridPreviewBox } from '../GridPreviewBox.tsx'
import { ResizeHandles } from '../ResizeHandles.tsx'
import { type ViewInfo } from '../streamwallState.tsx'
import { type useTileDrag } from '../useTileDrag.ts'
import { type useTileResize } from '../useTileResize.ts'
import {
  asCellIdx,
  asCellIdxs,
  asViewId,
  type CellIdx,
  type ViewId,
} from '../viewAddressing.ts'
import { resolveAnchorIdx } from '../viewPlacement.ts'

/**
 * The interactive wall grid: the invisible per-cell placement inputs, resize
 * handles, live preview boxes, and per-view control overlays. The tile drag and
 * resize interaction state arrive as the whole hook-return objects so their
 * shapes stay in sync with `useTileDrag`/`useTileResize`. Extracted from
 * ControlUI's composition root unchanged (issue #393).
 */
export function ControlGrid({
  cols,
  rows,
  windowWidth,
  windowHeight,
  role,
  showDebug,
  sharedState,
  views,
  stateIdxMap,
  streams,
  fullscreenViewIdx,
  tileDrag,
  tileResize,
  onSetView,
  onFocusInput,
  onBlurInput,
  onToggleFullscreen,
  onSetListening,
  onSetBackgroundListening,
  onSetBlurred,
  onSetVolume,
  onReloadView,
  onRotateView,
  onBrowse,
  onDevTools,
}: {
  cols: number
  rows: number
  windowWidth: number
  windowHeight: number
  role: StreamwallRole | null
  showDebug: boolean
  sharedState: CollabData | undefined
  views: ViewInfo[]
  stateIdxMap: Map<CellIdx, ViewInfo>
  streams: StreamData[]
  fullscreenViewIdx: CellIdx | null
  tileDrag: ReturnType<typeof useTileDrag>
  tileResize: ReturnType<typeof useTileResize>
  onSetView: (idx: CellIdx, streamId: string) => void
  onFocusInput: (idx: CellIdx) => void
  onBlurInput: () => void
  onToggleFullscreen: (viewId: ViewId) => void
  onSetListening: (viewId: ViewId, listening: boolean) => void
  onSetBackgroundListening: (viewId: ViewId, listening: boolean) => void
  onSetBlurred: (viewId: ViewId, blurred: boolean) => void
  onSetVolume: (viewId: ViewId, volume: number) => void
  onReloadView: (viewId: ViewId) => void
  onRotateView: (streamId: string) => void
  onBrowse: (streamId: string) => void
  onDevTools: (viewId: ViewId) => void
}) {
  const {
    hoveringIdx,
    swapStartIdx,
    moveStart,
    moveTargetIdx,
    updateHoveringIdx,
    clearHoveringIdx,
    handleSwapView,
    handleGridPointerDown,
  } = tileDrag
  const { resize, handleResizeStart, handleResizeKeyDown } = tileResize

  return (
    <StyledGridContainer
      className="grid"
      data-testid="grid"
      onPointerMove={updateHoveringIdx}
      onPointerLeave={clearHoveringIdx}
      $windowWidth={windowWidth}
      $windowHeight={windowHeight}
    >
      <StyledGridInputs>
        {range(0, rows).map((y) =>
          range(0, cols).map((x) => {
            const idx = asCellIdx(cols * y + x)
            const { streamId } = sharedState?.views?.[idx] ?? {}
            const isMoveHighlight =
              moveStart != null &&
              moveTargetIdx != null &&
              moveStart.idx !== moveTargetIdx &&
              (
                stateIdxMap.get(moveTargetIdx)?.spaces ?? [moveTargetIdx]
              ).includes(idx)
            const isResizeHighlight =
              resize != null &&
              hoveringIdx != null &&
              isIdxInResizeBox(
                cols,
                resize.anchorIdx,
                hoveringIdx,
                resize.handle,
                resize.originalSpaces,
                idx,
              )
            const isHighlighted = isMoveHighlight || isResizeHighlight
            return (
              <GridInput
                key={idx}
                style={{
                  width: `${100 / cols}%`,
                  height: `${100 / rows}%`,
                  left: `${(100 * x) / cols}%`,
                  top: `${(100 * y) / rows}%`,
                }}
                idx={idx}
                spaceValue={streamId ?? ''}
                onChangeSpace={onSetView}
                isHighlighted={isHighlighted}
                role={role}
                onPointerDown={handleGridPointerDown}
                onFocus={onFocusInput}
                onBlur={onBlurInput}
              />
            )
          }),
        )}
      </StyledGridInputs>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
        }}
      >
        {views.map(({ state }) => {
          const { pos } = state.context
          if (pos == null) {
            return null
          }
          const anchorIdx = Math.min(...pos.spaces)
          return (
            <div
              key={`rh-${anchorIdx}`}
              style={{
                position: 'absolute',
                left: `${(100 * pos.x) / windowWidth}%`,
                top: `${(100 * pos.y) / windowHeight}%`,
                width: `${(100 * pos.width) / windowWidth}%`,
                height: `${(100 * pos.height) / windowHeight}%`,
                pointerEvents: 'none',
              }}
            >
              <ResizeHandles
                anchorIdx={anchorIdx}
                originalSpaces={pos.spaces}
                role={role}
                onResizeStart={handleResizeStart}
                onResizeKeyDown={handleResizeKeyDown}
              />
            </div>
          )
        })}
      </div>
      <StyledGridPreview>
        {views.map(({ state, isListening, isPaused }) => {
          const { pos } = state.context
          if (pos == null) {
            return null
          }

          const { streamId } =
            sharedState?.views[
              resolveAnchorIdx(pos.spaces, fullscreenViewIdx)
            ] ?? {}
          const data = streams.find((d) => d._id === streamId)
          if (streamId == null || data == null) {
            return null
          }

          const isSmall = pos.height < 200
          const isError = matchesState('displaying.error', state.state)
          const errorReason = state.context.error
          return (
            <GridPreviewBox
              key={pos.spaces[0]}
              streamId={streamId}
              color={idColor(streamId)}
              style={{
                left: `${(100 * pos.x) / windowWidth}%`,
                top: `${(100 * pos.y) / windowHeight}%`,
                width: `${(100 * pos.width) / windowWidth}%`,
                height: `${(100 * pos.height) / windowHeight}%`,
              }}
              pos={pos}
              windowWidth={windowWidth}
              windowHeight={windowHeight}
              isListening={isListening}
              isSmall={isSmall}
              isError={isError}
              errorReason={errorReason}
              isPaused={isPaused}
              orientation={data?.orientation ?? null}
              source={data?.source}
              city={data?.city}
              state={data?.state}
            />
          )
        })}
      </StyledGridPreview>
      {views.map(
        ({ state, isListening, isBackgroundListening, isBlurred, volume }) => {
          const { pos } = state.context
          if (!pos) {
            return null
          }
          const { streamId } =
            sharedState?.views[
              resolveAnchorIdx(pos.spaces, fullscreenViewIdx)
            ] ?? {}
          if (!streamId) {
            return null
          }
          // The overlay addresses its view by id for the control commands and
          // by anchor cell for the swap gesture — two distinct axes (#507).
          const [anchorIdx] = asCellIdxs(pos.spaces)
          return (
            <GridControls
              key={pos.spaces[0]}
              idx={anchorIdx}
              viewId={asViewId(state.context.id)}
              streamId={streamId}
              onToggleFullscreen={onToggleFullscreen}
              style={{
                left: `${(100 * pos.x) / windowWidth}%`,
                top: `${(100 * pos.y) / windowHeight}%`,
                width: `${(100 * pos.width) / windowWidth}%`,
                height: `${(100 * pos.height) / windowHeight}%`,
              }}
              isDisplaying={matchesState('displaying', state.state)}
              isListening={isListening}
              isBackgroundListening={isBackgroundListening}
              isBlurred={isBlurred}
              volume={volume}
              isSwapping={
                swapStartIdx != null && pos.spaces.includes(swapStartIdx)
              }
              showDebug={showDebug}
              role={role}
              onSetListening={onSetListening}
              onSetBackgroundListening={onSetBackgroundListening}
              onSetBlurred={onSetBlurred}
              onSetVolume={onSetVolume}
              onReloadView={onReloadView}
              onSwapView={handleSwapView}
              onRotateView={onRotateView}
              onBrowse={onBrowse}
              onDevTools={onDevTools}
              onPointerDown={handleGridPointerDown}
            />
          )
        },
      )}
    </StyledGridContainer>
  )
}

const StyledGridPreview = styled.div`
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
`

const StyledGridInputs = styled.div`
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  transition: opacity 100ms ease-out;
  overflow: hidden;
  z-index: 100;
`

const StyledGridContainer = styled.div<{
  $windowWidth: number
  $windowHeight: number
}>`
  position: relative;
  /* Responsive: keep the wall's aspect ratio but fit the available space
     instead of a hard-coded pixel size, so the layout never overflows. */
  aspect-ratio: ${({ $windowWidth, $windowHeight }) =>
    `${$windowWidth} / ${$windowHeight}`};
  width: 100%;
  max-height: 100%;
  margin: 0 auto;
  border: 1px solid var(--border-2);
  border-radius: var(--r-md);
  background: var(--cell-bg);
  overflow: hidden;

  &:hover ${StyledGridInputs} {
    opacity: 0.35;
  }
`
