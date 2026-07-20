import { styled } from 'styled-components'

const StyledServerVersionLabel = styled.span`
  font-size: 12px;
  color: var(--text-dim);
`

/**
 * Unobtrusive running-server-version line for admins (#436), so checking it
 * no longer requires shelling into the host or hand-crafting an
 * `/admin/status` request.
 */
export function ServerVersionLabel({ version }: { version: string | null }) {
  if (version == null) {
    return null
  }

  return (
    <StyledServerVersionLabel className="server-version-label">
      &nbsp;· v{version}
    </StyledServerVersionLabel>
  )
}
