import { type JSX } from 'preact'
import { useCallback } from 'preact/hooks'
import {
  type CellIdx,
  Color,
  focusRingColors,
  idColor,
  roleCan,
  type StreamwallRole,
} from 'streamwall-shared'
import { styled } from 'styled-components'
import { type ColorInstance } from './colorTypes.ts'
import { LazyChangeInput } from './LazyChangeInput.tsx'

const StyledGridInputContainer = styled.div`
  position: absolute;
  touch-action: none;
`

/**
 * The colour a cell is actually painted with: the id-derived hue lightened to
 * the grid's tile lightness. Shared by the background and the focus ring, so
 * the ring is derived from what the eye sees rather than the raw id colour.
 */
export function cellColor(color: ColorInstance, isHighlighted?: boolean) {
  return Color(color).lightness(isHighlighted ? 90 : 75)
}

const StyledGridInput = styled(LazyChangeInput)<{
  $color: ColorInstance
  $isHighlighted?: boolean
}>`
  width: 100%;
  height: 100%;
  border: none;
  padding: 0;
  background: ${({ $color, $isHighlighted }) =>
    cellColor($color, $isHighlighted).hsl().string()};
  font-size: 20px;
  text-align: center;

  /* The cell divider. Scoped to :not(:focus-visible) so it cannot compete with
     the shared focus ring in globalStyle.tsx: both are single-class /
     single-pseudo-class selectors, so an unscoped outline here would win or
     lose purely by stylesheet injection order (see #531). */
  &:not(:focus-visible) {
    outline: 1px solid rgba(0, 0, 0, 0.5);
  }

  /* The shared ring is drawn outside the cell (outline-offset plus a halo), so
     the focused cell has to rise above its neighbours or the ring gets clipped
     by them. z-index only applies to positioned elements, hence the
     position.

     Being drawn outside also means the ring lands on the neighbouring tiles,
     whose colour is whatever their stream id hashes to - so the accent token
     can drop to ~2:1 against a red-ish neighbour. Only the colours are
     overridden here; width, offset and halo size stay with the shared rule in
     globalStyle.tsx so the grid keeps the same affordance (see #557). */
  &:focus-visible {
    position: relative;
    z-index: 100;
    outline-color: ${({ $color, $isHighlighted }) =>
      focusRingColors(cellColor($color, $isHighlighted)).ring};
    box-shadow: 0 0 0 4px
      ${({ $color, $isHighlighted }) =>
        focusRingColors(cellColor($color, $isHighlighted)).halo};
  }
`

export function GridInput({
  style,
  idx,
  onChangeSpace,
  spaceValue,
  isHighlighted,
  role,
  onPointerDown,
  onFocus,
  onBlur,
}: {
  style: JSX.HTMLAttributes['style']
  onPointerDown: JSX.PointerEventHandler<HTMLInputElement>
  idx: CellIdx
  onChangeSpace: (idx: CellIdx, value: string) => void
  spaceValue: string
  isHighlighted: boolean
  role: StreamwallRole | null
  onFocus: (idx: CellIdx) => void
  onBlur: (idx: CellIdx) => void
}) {
  const handleFocus = useCallback(() => {
    onFocus(idx)
  }, [onFocus, idx])
  const handleBlur = useCallback(() => {
    onBlur(idx)
  }, [onBlur, idx])
  const handleChange = useCallback(
    (value: string) => {
      onChangeSpace(idx, value)
    },
    [idx, onChangeSpace],
  )
  return (
    <StyledGridInputContainer style={style}>
      <StyledGridInput
        value={spaceValue}
        $color={idColor(spaceValue)}
        $isHighlighted={isHighlighted}
        disabled={!roleCan(role, 'mutate-state-doc')}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onPointerDown={onPointerDown}
        onChange={handleChange}
        isEager
        data-testid="grid-cell"
        data-idx={idx}
      />
    </StyledGridInputContainer>
  )
}
