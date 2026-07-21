import { type JSX } from 'preact'
import { useCallback } from 'preact/hooks'
import { Color, idColor, roleCan, type StreamwallRole } from 'streamwall-shared'
import { styled } from 'styled-components'
import { type ColorInstance } from './colorTypes.ts'
import { LazyChangeInput } from './LazyChangeInput.tsx'

const StyledGridInputContainer = styled.div`
  position: absolute;
  touch-action: none;
`

/**
 * The colour a tile actually paints for its stream colour: the same hue, but
 * lightened so the value stays readable on top of it (and lightened further
 * while the tile is a drag/resize highlight).
 */
export function tileColor(color: ColorInstance, isHighlighted = false) {
  return Color(color).lightness(isHighlighted ? 90 : 75)
}

/**
 * Ring and halo colours for the focused tile.
 *
 * The rest of the control UI takes its keyboard ring from the shared
 * `:focus-visible` rule in globalStyle.tsx, which draws `--accent` on the
 * neutral surface tokens. A tile's hue comes from the stream id, so a fixed
 * accent hue can land on a near-identical one and drop below the 3:1 that
 * WCAG 2.4.11 asks for. The colours are therefore derived from the tile:
 * whichever of black/white contrasts more becomes the ring, the other one the
 * halo just inside it, so the pair reads on any tile the grid can paint
 * (#531).
 */
export function focusRingColors(tile: ColorInstance) {
  const black = Color('black')
  const white = Color('white')
  const ringIsBlack = tile.contrast(black) >= tile.contrast(white)
  return {
    ring: (ringIsBlack ? black : white).hex(),
    halo: (ringIsBlack ? white : black).hex(),
  }
}

const StyledGridInput = styled(LazyChangeInput)<{
  $color: ColorInstance
  $isHighlighted?: boolean
}>`
  width: 100%;
  height: 100%;
  outline: 1px solid rgba(0, 0, 0, 0.5);
  border: none;
  padding: 0;
  background: ${({ $color, $isHighlighted }) =>
    tileColor($color, $isHighlighted).hsl().string()};
  font-size: 20px;
  text-align: center;

  /* Matches the shared affordance from globalStyle.tsx in shape and trigger -
     a 2px ring plus a halo, keyboard focus only - but with tile-derived
     colours (see focusRingColors). The ring is drawn inwards
     (outline-offset: -2px) because the tiles are laid out edge to edge inside
     an overflow: hidden layer, where an outset ring would be overlapped by
     its neighbours and clipped at the grid border. */
  &:focus-visible {
    outline: 2px solid
      ${({ $color, $isHighlighted }) =>
        focusRingColors(tileColor($color, $isHighlighted)).ring};
    outline-offset: -2px;
    box-shadow: 0 0 0 4px
      ${({ $color, $isHighlighted }) =>
        focusRingColors(tileColor($color, $isHighlighted)).halo}
      inset;
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
  idx: number
  onChangeSpace: (idx: number, value: string) => void
  spaceValue: string
  isHighlighted: boolean
  role: StreamwallRole | null
  onFocus: (idx: number) => void
  onBlur: (idx: number) => void
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
