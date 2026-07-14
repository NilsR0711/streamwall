import { Color } from 'streamwall-shared'
import { styled } from 'styled-components'

// Generic button/data-container primitives shared by the connection-status
// header, the streamdelay censor/uncensor box, and the per-tile grid
// controls.

export const StyledDataContainer = styled.div<{ $isConnected?: boolean }>`
  opacity: ${({ $isConnected }) => ($isConnected ? 1 : 0.5)};
`

export const StyledButton = styled.button<{
  $isActive?: boolean
  $activeColor?: string
}>`
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-2);
  background: var(--surface-3);
  color: var(--text-dim);
  border-radius: var(--r-sm);
  padding: 4px;
  cursor: pointer;

  &:hover {
    color: var(--text);
    border-color: var(--text-faint);
  }

  ${({ $isActive, $activeColor = 'red' }) =>
    $isActive &&
    `
      border-color: ${Color($activeColor).hsl().string()};
      background: ${Color($activeColor).hsl().string()};
      color: #fff;
    `};

  &:focus {
    outline: none;
    box-shadow: 0 0 0 2px var(--accent-soft);
  }

  svg {
    width: 20px;
    height: 20px;
  }
`

export const StyledSmallButton = styled(StyledButton)`
  svg {
    width: 14px;
    height: 14px;
  }
`

export const StyledVolumeSlider = styled.input`
  width: 54px;
  height: 24px;
  margin: 5px;
  accent-color: var(--accent-2);
  cursor: pointer;
`
