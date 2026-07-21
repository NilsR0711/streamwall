import { type LayoutPreset, type StreamwallRole } from 'streamwall-shared'
import { styled } from 'styled-components'
import { ThemeToggle } from '../globalStyle.tsx'
import { GridSizeControls } from '../GridSizeControls.tsx'
import { NARROW_BREAKPOINT } from '../layout.tsx'
import { LayoutPresetControls } from '../LayoutPresetControls.tsx'
import { ServerVersionLabel } from '../ServerVersionLabel.tsx'

/**
 * The wall's masthead: brand mark, grid-size breadcrumb + controls, layout
 * presets, live-count badge, connection/role status, and the theme toggle.
 * Extracted from ControlUI's composition root unchanged (issue #393).
 */
export function ControlHeader({
  cols,
  rows,
  role,
  onSetGridSize,
  presets,
  onSavePreset,
  onLoadPreset,
  onDeletePreset,
  liveCount,
  isConnected,
  serverVersion,
}: {
  cols: number | null
  rows: number | null
  role: StreamwallRole | null
  onSetGridSize: (cols: number, rows: number) => void
  presets: LayoutPreset[]
  onSavePreset: (name: string) => void
  onLoadPreset: (presetId: string) => void
  onDeletePreset: (presetId: string) => void
  liveCount: number
  isConnected: boolean
  serverVersion: string | null
}) {
  return (
    <StyledHeader>
      <div className="wm">
        STREAM<span>·</span>WALL
      </div>
      <div className="crumbs">
        //&nbsp; <b>Multiview</b> &nbsp;·&nbsp; {cols}×{rows}
      </div>
      {cols != null && rows != null && (
        <GridSizeControls
          cols={cols}
          rows={rows}
          role={role}
          onSetGridSize={onSetGridSize}
        />
      )}
      <LayoutPresetControls
        presets={presets}
        role={role}
        onSavePreset={onSavePreset}
        onLoadPreset={onLoadPreset}
        onDeletePreset={onDeletePreset}
      />
      <div className="spacer" />
      {liveCount > 0 && <div className="livecount">● {liveCount} On Air</div>}
      {role !== 'local' && (
        <div className="status" data-testid="header-connection-status">
          <span className={`dot ${isConnected ? 'on' : 'off'}`} />
          {isConnected ? 'connected' : 'connecting...'} · {role}
          <ServerVersionLabel version={serverVersion} />
        </div>
      )}
      <ThemeToggle />
    </StyledHeader>
  )
}

const StyledHeader = styled.header`
  display: flex;
  align-items: center;
  gap: 18px;
  flex: 0 0 auto;
  position: relative;
  padding: 4px 2px 14px;
  margin-bottom: 14px;

  /* Stencil-editorial anchor: a red rule that runs out into the border line. */
  &::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 2px;
    background: linear-gradient(
      90deg,
      var(--accent) 0 132px,
      var(--border) 132px
    );
  }

  .wm {
    font-family: var(--font-display);
    font-size: 27px;
    line-height: 1;
    letter-spacing: 0.03em;
    color: var(--text);
    white-space: nowrap;
  }
  .wm span {
    color: var(--accent);
  }

  .crumbs {
    font-family: var(--font-mono);
    font-size: 12px;
    letter-spacing: 0.04em;
    color: var(--text-faint);
  }
  .crumbs b {
    color: var(--text-dim);
    font-weight: 500;
  }

  .spacer {
    flex: 1;
  }

  .livecount {
    font-family: 'Oswald', var(--font-ui);
    text-transform: uppercase;
    font-weight: 600;
    font-size: 13px;
    letter-spacing: 0.12em;
    color: var(--accent);
    border: 1px solid var(--accent);
    background: var(--accent-soft);
    padding: 5px 11px;
  }

  .status {
    display: flex;
    align-items: center;
    gap: 7px;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.02em;
    color: var(--text-dim);
    text-transform: uppercase;
  }
  .status .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
  .status .dot.on {
    background: var(--ok);
  }
  .status .dot.off {
    background: var(--text-faint);
  }

  /* On narrow screens the header controls no longer fit on one line - let them
     wrap instead of overflowing the viewport (see #81). */
  @media (max-width: ${NARROW_BREAKPOINT}px) {
    flex-wrap: wrap;
    gap: 10px 14px;
  }
`
