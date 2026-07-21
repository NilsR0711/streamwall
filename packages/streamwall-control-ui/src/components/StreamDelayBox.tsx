import { DateTime } from 'luxon'
import { useCallback, useEffect, useState } from 'preact/hooks'
import {
  roleCan,
  type StreamDelayStatus,
  type StreamwallRole,
} from 'streamwall-shared'
import { styled } from 'styled-components'
import { matchesState } from 'xstate'
import { StyledButton } from '../StyledButton.tsx'

function StreamDurationClock({ startTime }: { startTime: number }) {
  const [now, setNow] = useState(() => DateTime.now())
  useEffect(() => {
    const interval = setInterval(() => {
      setNow(DateTime.now())
    }, 500)
    return () => {
      clearInterval(interval)
    }
  }, [startTime])
  return (
    <span>{now.diff(DateTime.fromMillis(startTime)).toFormat('hh:mm:ss')}</span>
  )
}

/**
 * The Streamdelay control strip: shows connection/running state and the delay
 * duration, and (role permitting) the censor and start/stop-stream buttons.
 * Extracted from ControlUI's composition root unchanged (issue #393).
 */
export function StreamDelayBox({
  role,
  delayState,
  setStreamCensored,
  setStreamRunning,
}: {
  role: StreamwallRole | null
  delayState: StreamDelayStatus
  setStreamCensored: (isCensored: boolean) => void
  setStreamRunning: (isStreamRunning: boolean) => void
}) {
  const handleToggleStreamCensored = useCallback(() => {
    setStreamCensored(!delayState.isCensored)
  }, [delayState.isCensored, setStreamCensored])
  const handleToggleStreamRunning = useCallback(() => {
    if (!delayState.isStreamRunning || confirm('End stream?')) {
      setStreamRunning(!delayState.isStreamRunning)
    }
  }, [delayState.isStreamRunning, setStreamRunning])
  let buttonText
  if (delayState.isConnected) {
    if (matchesState('censorship.censored.deactivating', delayState.state)) {
      buttonText = 'Deactivating...'
    } else if (delayState.isCensored) {
      buttonText = 'Uncensor stream'
    } else {
      buttonText = 'Censor stream'
    }
  }
  return (
    <div>
      <StyledStreamDelayBox>
        <strong>Streamdelay</strong>
        {!delayState.isConnected && <span>connecting...</span>}
        {!delayState.isStreamRunning && <span>stream stopped</span>}
        {delayState.isConnected && (
          <>
            {delayState.startTime !== null && (
              <StreamDurationClock startTime={delayState.startTime} />
            )}
            <span>delay: {delayState.delaySeconds}s</span>
            {delayState.isStreamRunning && (
              <StyledButton
                $isActive={delayState.isCensored}
                onClick={handleToggleStreamCensored}
              >
                {buttonText}
              </StyledButton>
            )}
            {roleCan(role, 'set-stream-running') && (
              <StyledButton onClick={handleToggleStreamRunning}>
                {delayState.isStreamRunning ? 'End stream' : 'Start stream'}
              </StyledButton>
            )}
          </>
        )}
      </StyledStreamDelayBox>
    </div>
  )
}

const StyledStreamDelayBox = styled.div`
  display: inline-flex;
  align-items: center;
  margin: 5px 0;
  padding: 10px 12px;
  gap: 1em;
  border-radius: var(--r-md);
  background: var(--accent-soft);
  border: 1px solid var(--accent);
  color: var(--text);
`
