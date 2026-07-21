import { type JSX } from 'preact'
import { useCallback } from 'preact/hooks'
import { roleCan, type StreamwallRole } from 'streamwall-shared'
import { styled } from 'styled-components'

/**
 * The wall column's footer bar: the debug-tools toggle (shown only to roles
 * that can use it) and the source/live counts. Extracted from ControlUI's
 * composition root unchanged (issue #393).
 */
export function ControlStatusBar({
  role,
  showDebug,
  onSetShowDebug,
  sourceCount,
  liveCount,
}: {
  role: StreamwallRole | null
  showDebug: boolean
  onSetShowDebug: (showDebug: boolean) => void
  sourceCount: number
  liveCount: number
}) {
  const handleChangeShowDebug = useCallback<
    JSX.InputEventHandler<HTMLInputElement>
  >(
    (ev) => {
      onSetShowDebug(ev.currentTarget.checked)
    },
    [onSetShowDebug],
  )
  return (
    <StyledStatusBar>
      {(roleCan(role, 'dev-tools') || roleCan(role, 'browse')) && (
        <label className="dbg">
          <input
            type="checkbox"
            checked={showDebug}
            onChange={handleChangeShowDebug}
          />
          Debug-Tools
        </label>
      )}
      <span className="spacer" />
      <span className="meta">
        {sourceCount} sources · {liveCount} live
      </span>
    </StyledStatusBar>
  )
}

const StyledStatusBar = styled.div`
  display: flex;
  align-items: center;
  gap: 14px;
  flex: 0 0 auto;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-dim);

  .spacer {
    flex: 1;
  }

  .meta {
    color: var(--text-faint);
  }

  label.dbg {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  label.dbg input {
    accent-color: var(--accent);
  }
`
