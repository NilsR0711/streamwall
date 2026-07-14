import { FaExclamationTriangle, FaSyncAlt } from 'react-icons/fa'
import { type ConnectionStatus } from 'streamwall-shared'
import { styled } from 'styled-components'

const StyledConnectionStatusBanner = styled.div<{ $severe: boolean }>`
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: ${({ $severe }) => ($severe ? 'var(--live)' : '#e0a800')};
`

const MESSAGE_BY_STATUS: Partial<Record<ConnectionStatus, string>> = {
  reconnecting:
    'Reconnecting to the control server — showing the last known state.',
  unauthorized:
    'Session is no longer authorized. Reload the page or request a new invite link.',
  'server-down':
    'The Streamwall app disconnected from the control server. Waiting for it to reconnect…',
}

const SEVERE_STATUSES = new Set<ConnectionStatus>([
  'unauthorized',
  'server-down',
])

/**
 * Explains *why* the client is disconnected instead of leaving the operator
 * to guess from a generic spinner, and only fires once there's previously
 * shown state to explain the loss of (a first-ever connect gets the normal
 * "connecting" experience elsewhere in the UI) (issue #37).
 */
export function ConnectionStatusBanner({
  connectionStatus,
  hasKnownState,
}: {
  connectionStatus: ConnectionStatus
  hasKnownState: boolean
}) {
  if (connectionStatus === 'connected') {
    return null
  }
  if (connectionStatus === 'connecting' && !hasKnownState) {
    return null
  }

  const message =
    MESSAGE_BY_STATUS[connectionStatus] ?? MESSAGE_BY_STATUS.reconnecting
  const severe = SEVERE_STATUSES.has(connectionStatus)

  return (
    <StyledConnectionStatusBanner
      className={`connection-status-banner ${severe ? 'severe' : 'warning'}`}
      $severe={severe}
    >
      {severe ? <FaExclamationTriangle /> : <FaSyncAlt />}
      {message}
    </StyledConnectionStatusBanner>
  )
}
