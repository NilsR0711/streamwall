import { styled } from 'styled-components'

const Banner = styled.div`
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  background: var(--surface-2);
  border-bottom: 1px solid var(--border);
  color: var(--text);
  font-family: var(--font-ui);
  font-size: 13px;
`

const Message = styled.div`
  flex: 1;
  min-width: 0;
`

const ConfigPath = styled.code`
  font-family: var(--font-mono);
  background: var(--surface-3);
  border-radius: var(--r-sm);
  padding: 1px 5px;
  word-break: break-all;
`

const ActionButton = styled.button`
  flex-shrink: 0;
  background: var(--accent-2);
  color: var(--surface);
  border: none;
  border-radius: var(--r-sm);
  padding: 6px 10px;
  font-family: var(--font-ui);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
`

const DismissButton = styled.button`
  flex-shrink: 0;
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  padding: 4px;
`

export interface FirstRunHintProps {
  configPath: string
  onOpenConfigFolder: () => void
  onDismiss: () => void
}

/**
 * Shown when the app started with no userData config.toml (#86): the wall
 * and control window are otherwise silently empty, with the config path
 * previously surfaced only via `console.debug`.
 */
export function FirstRunHint({
  configPath,
  onOpenConfigFolder,
  onDismiss,
}: FirstRunHintProps) {
  return (
    <Banner>
      <Message>
        No <ConfigPath>config.toml</ConfigPath> found yet, so the wall has no
        streams configured. Add one at <ConfigPath>{configPath}</ConfigPath>, or
        pass <ConfigPath>--config</ConfigPath> / data source flags on the
        command line.
      </Message>
      <ActionButton
        data-testid="open-config-folder"
        onClick={onOpenConfigFolder}
      >
        Open Config Folder
      </ActionButton>
      <DismissButton
        data-testid="dismiss-first-run-hint"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        ×
      </DismissButton>
    </Banner>
  )
}
