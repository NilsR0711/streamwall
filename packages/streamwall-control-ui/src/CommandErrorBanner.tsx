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
 *
 * The live region itself stays mounted while there is no error and only its
 * contents are swapped: `aria-live` announcements are only reliable for
 * changes inside a region that already exists in the accessibility tree, so
 * mounting the region together with its first message risks losing exactly
 * that first announcement (WCAG 4.1.3, issue #463).
 */
export function CommandErrorBanner({
  error,
  onDismiss,
}: {
  error: string | null
  onDismiss: () => void
}) {
  return (
    <StyledCommandErrorBanner
      className="command-error-banner"
      role="alert"
      aria-live="assertive"
    >
      {error != null && (
        <>
          <FaExclamationTriangle />
          <span>Action failed: {error}</span>
          <button type="button" onClick={onDismiss}>
            Dismiss
          </button>
        </>
      )}
    </StyledCommandErrorBanner>
  )
}
