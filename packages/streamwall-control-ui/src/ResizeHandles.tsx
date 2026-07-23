import { type CellIdx, roleCan, type StreamwallRole } from 'streamwall-shared'
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

// Visually hidden but still exposed to assistive technology, so the keyboard
// hint referenced by `aria-describedby` is announced to screen-reader users
// without taking up any visible space (the standard sr-only clip pattern).
const VisuallyHidden = styled.span`
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
`

// A keyboard resize step that would overwrite a neighbor's cells is blocked
// (see handleResizeKeyDown); this hint surfaces the Shift-key override so
// that block is discoverable rather than a silent no-op.
const RESIZE_KEYBOARD_HINT =
  'Arrow keys resize. Hold Shift to overwrite another tile.'

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
  tileLabel,
  role,
  onResizeStart,
  onResizeKeyDown,
}: {
  anchorIdx: CellIdx
  originalSpaces: CellIdx[]
  // A human-readable identifier for the tile these handles resize (the stream
  // label or, failing that, the cell position), folded into each button's
  // aria-label so screen-reader users can tell one tile's handles from the
  // next instead of hearing a run of identical "Resize right edge" buttons
  // (issue #625, WCAG 2.4.6).
  tileLabel: string
  role: StreamwallRole | null
  onResizeStart: (
    anchorIdx: CellIdx,
    handle: ResizeHandle,
    originalSpaces: CellIdx[],
    ev: PointerEvent,
  ) => void
  onResizeKeyDown: (
    anchorIdx: CellIdx,
    handle: ResizeHandle,
    originalSpaces: CellIdx[],
    ev: KeyboardEvent,
  ) => void
}) {
  // Gated the same way `GridInput` already is (issue #286): unlike a plain
  // `disabled` attribute, this also short-circuits the callbacks themselves,
  // so a monitor-role client can't start a resize gesture even if a
  // pointerdown/keydown somehow still reached a disabled button.
  const disabled = !roleCan(role, 'mutate-state-doc')
  // Unique per tile so multiple mounted ResizeHandles don't share a DOM id;
  // all three buttons of one tile reference the same hint text.
  const hintId = `resize-keyboard-hint-${anchorIdx}`
  return (
    <StyledResizeHandles>
      {RESIZE_HANDLES.map(({ handle, className, label }) => (
        <button
          key={handle}
          type="button"
          className={className}
          aria-label={`${label} of ${tileLabel}`}
          aria-describedby={hintId}
          title={RESIZE_KEYBOARD_HINT}
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
      <VisuallyHidden id={hintId}>{RESIZE_KEYBOARD_HINT}</VisuallyHidden>
    </StyledResizeHandles>
  )
}
