import { styled } from 'styled-components'

export const Stack = styled.div<{
  $direction?: string
  $flex?: string
  $gap?: number
  $scroll?: boolean
  $minHeight?: number
}>`
  display: flex;
  flex-direction: ${({ $direction }) => $direction ?? 'column'};
  flex: ${({ $flex }) => $flex};
  ${({ $gap }) => $gap && `gap: ${$gap}px`};
  ${({ $scroll }) => $scroll && `overflow-y: auto`};
  ${({ $minHeight }) => $minHeight && `min-height: ${$minHeight}px`};
`

// Below this viewport width the side-by-side wall/stream-list layout stops
// fitting, so the shell stacks the two regions vertically instead (see #81).
// Shared with the header so both switch to their narrow layout together.
export const NARROW_BREAKPOINT = 820

// Root layout. Desktop: the wall preview and the stream list sit side by side,
// pinned to the viewport height with only the stream list scrolling. Narrow
// screens (phones, small windows): the two regions stack and the whole page
// scrolls. Layout that the media query needs to override lives here rather than
// as inline styles on the children so the cascade can win cleanly.
export const AppShell = styled.div`
  display: flex;
  flex: 1;
  flex-direction: row;
  gap: 16px;
  height: 100vh;
  min-height: 0;
  padding: 16px;
  overflow: hidden;

  > .grid-container {
    flex: 1;
    min-width: 0;
    min-height: 0;
  }

  > .stream-list {
    flex: 0 0 340px;
    /* The sidebar is the scrolling region (overflow-y: auto), and overflow
       clipping applies on both axes. Its filter input spans the full width and
       the shared :focus-visible ring is drawn outside the control, so without
       this much horizontal room the ring's left and right edges would be
       clipped away (see #553). */
    padding-inline: 6px;
  }

  @media (max-width: ${NARROW_BREAKPOINT}px) {
    flex-direction: column;
    height: auto;
    min-height: 100vh;
    overflow: visible;

    /* Stack both regions at their natural height and let the whole page
       scroll, rather than pinning them to the viewport and competing for its
       height (which collapses the wall region to nothing). */
    > .grid-container {
      flex: 0 0 auto;
    }

    > .stream-list {
      flex: 0 0 auto;
      min-width: 0;
      overflow-y: visible;
    }
  }
`
