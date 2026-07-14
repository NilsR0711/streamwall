import { type JSX } from 'preact'
import { useCallback, useEffect, useState } from 'preact/hooks'
import {
  GRID_MAX,
  GRID_MIN,
  parseGridDimensionInput,
  roleCan,
  type StreamwallRole,
} from 'streamwall-shared'
import { styled } from 'styled-components'

const StyledGridSizeControls = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;

  button.preset {
    padding: 2px 8px;
    border: 1px solid var(--border, #444);
    background: transparent;
    color: inherit;
    border-radius: 4px;
    cursor: pointer;
    font: inherit;
  }
  button.preset.active {
    border-color: var(--accent, #e23);
    color: var(--accent, #e23);
  }
  label {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
  }
  input {
    width: 44px;
    background: transparent;
    color: inherit;
    border: 1px solid var(--border, #444);
    border-radius: 4px;
    padding: 2px 4px;
  }
`

const GRID_PRESETS: Array<[number, number]> = [
  [2, 2],
  [3, 3],
  [4, 4],
  [2, 3],
  [3, 2],
  [4, 3],
]

export function GridSizeControls({
  cols,
  rows,
  role,
  onSetGridSize,
}: {
  cols: number
  rows: number
  role: StreamwallRole | null
  onSetGridSize: (cols: number, rows: number) => void
}) {
  const disabled = !roleCan(role, 'mutate-state-doc')

  // The inputs hold a local draft while the user types so that transient
  // states (an empty or out-of-range field) never reach the grid. The change
  // is committed only on blur/Enter, and only when it parses to a valid,
  // in-range dimension — otherwise the field reverts to the authoritative
  // value. This prevents a cleared field (NaN) from collapsing the wall.
  const [colsDraft, setColsDraft] = useState(String(cols))
  const [rowsDraft, setRowsDraft] = useState(String(rows))
  useEffect(() => setColsDraft(String(cols)), [cols])
  useEffect(() => setRowsDraft(String(rows)), [rows])

  const commitCols = useCallback(
    (raw: string) => {
      const parsed = parseGridDimensionInput(raw)
      if (parsed !== null && parsed !== cols) {
        onSetGridSize(parsed, rows)
      }
      setColsDraft(String(cols))
    },
    [cols, rows, onSetGridSize],
  )
  const commitRows = useCallback(
    (raw: string) => {
      const parsed = parseGridDimensionInput(raw)
      if (parsed !== null && parsed !== rows) {
        onSetGridSize(cols, parsed)
      }
      setRowsDraft(String(rows))
    },
    [cols, rows, onSetGridSize],
  )

  const commitOnEnter: JSX.KeyboardEventHandler<HTMLInputElement> = (ev) => {
    if (ev.key === 'Enter') {
      ev.currentTarget.blur()
    }
  }

  return (
    <StyledGridSizeControls>
      {GRID_PRESETS.map(([c, r]) => (
        <button
          key={`${c}x${r}`}
          type="button"
          className={c === cols && r === rows ? 'preset active' : 'preset'}
          disabled={disabled}
          onClick={() => onSetGridSize(c, r)}
        >
          {c}×{r}
        </button>
      ))}
      <label>
        Columns
        <input
          type="number"
          min={GRID_MIN}
          max={GRID_MAX}
          value={colsDraft}
          disabled={disabled}
          onInput={(ev) => setColsDraft(ev.currentTarget.value)}
          onBlur={(ev) => commitCols(ev.currentTarget.value)}
          onKeyDown={commitOnEnter}
        />
      </label>
      <label>
        Rows
        <input
          type="number"
          min={GRID_MIN}
          max={GRID_MAX}
          value={rowsDraft}
          disabled={disabled}
          onInput={(ev) => setRowsDraft(ev.currentTarget.value)}
          onBlur={(ev) => commitRows(ev.currentTarget.value)}
          onKeyDown={commitOnEnter}
        />
      </label>
    </StyledGridSizeControls>
  )
}
