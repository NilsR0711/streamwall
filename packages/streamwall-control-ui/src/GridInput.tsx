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
    $isHighlighted
      ? Color($color).lightness(90).hsl().string()
      : Color($color).lightness(75).hsl().string()};
  font-size: 20px;
  text-align: center;

  &:focus {
    outline: 1px solid black;
    box-shadow: 0 0 5px black inset;
    z-index: 100;
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
