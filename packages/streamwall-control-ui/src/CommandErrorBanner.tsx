import { FaExclamationTriangle } from 'react-icons/fa'
import { styled } from 'styled-components'

const StyledCommandErrorBanner = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #e0a800;

  button {
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    font-size: 12px;
    padding: 0;
    text-decoration: underline;
  }
`

/**
 * Surfaces a control-server command error (e.g. `unauthorized`) that would
 * otherwise be dropped silently by callers that don't pass a response
 * callback to `send` (issue #35).
 */
export function CommandErrorBanner({
  error,
  onDismiss,
}: {
  error: string | null
  onDismiss: () => void
}) {
  if (error == null) {
    return null
  }

  return (
    <StyledCommandErrorBanner
      className="command-error-banner"
      role="alert"
      aria-live="assertive"
    >
      <FaExclamationTriangle />
      <span>Action failed: {error}</span>
      <button type="button" onClick={onDismiss}>
        Dismiss
      </button>
    </StyledCommandErrorBanner>
  )
}
