import { type JSX } from 'preact'
import { useCallback, useState } from 'preact/hooks'
import {
  roleCan,
  type LayoutPreset,
  type StreamwallRole,
} from 'streamwall-shared'
import { styled } from 'styled-components'

const StyledLayoutPresetControls = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;

  form {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  input {
    width: 140px;
    background: transparent;
    color: inherit;
    border: 1px solid var(--border, #444);
    border-radius: 4px;
    padding: 2px 4px;
    font: inherit;
  }
  button {
    padding: 2px 8px;
    border: 1px solid var(--border, #444);
    background: transparent;
    color: inherit;
    border-radius: 4px;
    cursor: pointer;
    font: inherit;
  }
  .preset-chip {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }
  button.delete {
    padding: 2px 6px;
    color: var(--text-dim, #888);
  }
`

/**
 * Save-current-layout form plus a row of saved presets, each loadable or
 * deletable in one click. Fits next to `GridSizeControls` in the header, per
 * issue #78.
 */
export function LayoutPresetControls({
  presets,
  role,
  onSavePreset,
  onLoadPreset,
  onDeletePreset,
}: {
  presets: LayoutPreset[]
  role: StreamwallRole | null
  onSavePreset: (name: string) => void
  onLoadPreset: (id: string) => void
  onDeletePreset: (id: string) => void
}) {
  const disabled = !roleCan(role, 'save-layout-preset')

  const [nameDraft, setNameDraft] = useState('')

  const handleChangeName = useCallback<JSX.InputEventHandler<HTMLInputElement>>(
    (ev) => {
      setNameDraft(ev.currentTarget.value)
    },
    [],
  )

  const handleSubmit = useCallback<JSX.SubmitEventHandler<HTMLFormElement>>(
    (ev) => {
      ev.preventDefault()
      const name = nameDraft.trim()
      if (!name) {
        return
      }
      onSavePreset(name)
      setNameDraft('')
    },
    [nameDraft, onSavePreset],
  )

  return (
    <StyledLayoutPresetControls>
      <form onSubmit={handleSubmit}>
        <input
          placeholder="Preset name"
          value={nameDraft}
          disabled={disabled}
          onInput={handleChangeName}
        />
        <button type="submit" disabled={disabled}>
          save layout
        </button>
      </form>
      {presets.map((preset) => (
        <span className="preset-chip" key={preset.id}>
          <button
            type="button"
            className="preset"
            disabled={disabled}
            onClick={() => onLoadPreset(preset.id)}
          >
            {preset.name}
          </button>
          <button
            type="button"
            className="delete"
            disabled={disabled}
            aria-label={`Delete preset ${preset.name}`}
            onClick={() => onDeletePreset(preset.id)}
          >
            ×
          </button>
        </span>
      ))}
    </StyledLayoutPresetControls>
  )
}
