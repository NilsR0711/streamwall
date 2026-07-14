import { FaExclamationTriangle } from 'react-icons/fa'
import type { DisconnectReason } from 'streamwall-shared'
import { styled } from 'styled-components'

const StyledConnectionStatusBanner = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #e0a800;

  &.unauthorized {
    color: #dc3545;
  }
`

const MESSAGE_BY_REASON: Record<DisconnectReason, string> = {
  unauthorized: 'Session invalid - please sign in again.',
  'streamwall-disconnected': 'Streamwall app disconnected - reconnecting...',
}

const GENERIC_MESSAGE = 'Connection lost - reconnecting...'

/**
 * Replaces blanking the wall/list on any websocket blip (issue #37): the
 * grid and stream list now keep rendering their last-known state (dimmed via
 * `StyledDataContainer`'s `$isConnected`) instead of unmounting, so this
 * banner is the explicit "why" that previously only a small header dot
 * hinted at - and it distinguishes an invalid session from the Streamwall
 * app itself being unreachable, rather than a single generic message.
 */
export function ConnectionStatusBanner({
  isConnected,
  reason,
}: {
  isConnected: boolean
  reason: DisconnectReason | null | undefined
}) {
  if (isConnected) {
    return null
  }

  return (
    <StyledConnectionStatusBanner className={reason ?? undefined} role="status">
      <FaExclamationTriangle />
      {reason ? MESSAGE_BY_REASON[reason] : GENERIC_MESSAGE}
    </StyledConnectionStatusBanner>
  )
}
