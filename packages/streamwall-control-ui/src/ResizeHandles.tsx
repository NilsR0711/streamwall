import { roleCan, type StreamwallRole } from 'streamwall-shared'
import { styled } from 'styled-components'
import { type ResizeHandle } from './gridInteractions'

const StyledResizeHandles = styled.div`
  position: absolute;
  inset: 0;
  pointer-events: none;

  .handle {
    position: absolute;
    pointer-events: auto;
    touch-action: none;
    background: var(--accent, #e23);
    opacity: 0;
    transition: opacity 0.1s;
    border: 0;
    margin: 0;
    padding: 0;
    appearance: none;
  }
  &:hover .handle {
    opacity: 0.6;
  }
  /* Touch/pen devices have no hover state to reveal the handles, so keep
     them visible without it — otherwise they're impossible to find. */
  @media (hover: none), (pointer: coarse) {
    .handle {
      opacity: 0.6;
    }
  }
  /* A focused handle needs to be visible even without a hover, so it can be
     found and operated by keyboard (arrow keys resize, see
     handleResizeKeyDown). */
  .handle:focus-visible {
    opacity: 1;
    outline: 2px solid var(--accent, #e23);
    outline-offset: 2px;
  }
  .handle.e {
    top: 20%;
    bottom: 20%;
    right: -3px;
    width: 6px;
    cursor: ew-resize;
  }
  .handle.s {
    left: 20%;
    right: 20%;
    bottom: -3px;
    height: 6px;
    cursor: ns-resize;
  }
  .handle.se {
    right: -4px;
    bottom: -4px;
    width: 10px;
    height: 10px;
    cursor: nwse-resize;
    opacity: 0.8;
    border-radius: 2px;
  }
`

const RESIZE_HANDLES: {
  handle: ResizeHandle
  className: string
  label: string
}[] = [
  { handle: 'e', className: 'handle e', label: 'Resize right edge' },
  { handle: 's', className: 'handle s', label: 'Resize bottom edge' },
  { handle: 'se', className: 'handle se', label: 'Resize bottom-right corner' },
]

export function ResizeHandles({
  anchorIdx,
  originalSpaces,
  role,
  onResizeStart,
  onResizeKeyDown,
}: {
  anchorIdx: number
  originalSpaces: number[]
  role: StreamwallRole | null
  onResizeStart: (
    anchorIdx: number,
    handle: ResizeHandle,
    originalSpaces: number[],
    ev: PointerEvent,
  ) => void
  onResizeKeyDown: (
    anchorIdx: number,
    handle: ResizeHandle,
    originalSpaces: number[],
    ev: KeyboardEvent,
  ) => void
}) {
  // Gated the same way `GridInput` already is (issue #286): unlike a plain
  // `disabled` attribute, this also short-circuits the callbacks themselves,
  // so a monitor-role client can't start a resize gesture even if a
  // pointerdown/keydown somehow still reached a disabled button.
  const disabled = !roleCan(role, 'mutate-state-doc')
  return (
    <StyledResizeHandles>
      {RESIZE_HANDLES.map(({ handle, className, label }) => (
        <button
          key={handle}
          type="button"
          className={className}
          aria-label={label}
          disabled={disabled}
          onPointerDown={(ev) => {
            if (!disabled) {
              onResizeStart(anchorIdx, handle, originalSpaces, ev)
            }
          }}
          onKeyDown={(ev) => {
            if (!disabled) {
              onResizeKeyDown(anchorIdx, handle, originalSpaces, ev)
            }
          }}
        />
      ))}
    </StyledResizeHandles>
  )
}
