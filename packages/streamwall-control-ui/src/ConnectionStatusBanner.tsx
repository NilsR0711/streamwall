import { FaExclamationTriangle } from 'react-icons/fa'
import type { DisconnectReason } from 'streamwall-shared'
import { styled } from 'styled-components'

const StyledConnectionStatusBanner = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #e0a800;

  .connection-status-message {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .unauthorized {
    color: #dc3545;
  }
`

const MESSAGE_BY_REASON: Record<DisconnectReason, string> = {
  unauthorized: 'Session invalid - please sign in again.',
  'streamwall-disconnected': 'Streamwall app disconnected - reconnecting...',
  'rate-limited': 'Too many messages sent - reconnecting...',
}

const GENERIC_MESSAGE = 'Connection lost - reconnecting...'

/**
 * Replaces blanking the wall/list on any websocket blip (issue #37): the
 * grid and stream list now keep rendering their last-known state (dimmed via
 * `StyledDataContainer`'s `$isConnected`) instead of unmounting, so this
 * banner is the explicit "why" that previously only a small header dot
 * hinted at - and it distinguishes an invalid session from the Streamwall
 * app itself being unreachable, rather than a single generic message.
 *
 * The live region itself stays mounted while connected and only its contents
 * are swapped: `aria-live` announcements are only reliable for changes inside
 * a region that already exists in the accessibility tree, so mounting the
 * region together with its first message risks losing exactly that first
 * announcement (WCAG 4.1.3, issue #463). The `data-testid` therefore sits on
 * the message, which is still present only while disconnected.
 */
export function ConnectionStatusBanner({
  isConnected,
  reason,
}: {
  isConnected: boolean
  reason: DisconnectReason | null | undefined
}) {
  return (
    <StyledConnectionStatusBanner role="status" aria-live="polite">
      {!isConnected && (
        <span
          className={`connection-status-message ${reason ?? ''}`.trim()}
          data-testid="connection-status-banner"
        >
          <FaExclamationTriangle />
          {reason ? MESSAGE_BY_REASON[reason] : GENERIC_MESSAGE}
        </span>
      )}
    </StyledConnectionStatusBanner>
  )
}
