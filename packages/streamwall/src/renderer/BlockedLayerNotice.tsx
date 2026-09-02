import { styled } from 'styled-components'

/**
 * Stands in for an overlay or background iframe whose URL the session's SSRF
 * request guard refused to fetch.
 *
 * Without it the layer is simply blank: unlike a stream view a layer has no
 * `did-fail-load` surface, and a cancelled load inside an iframe would not
 * reach one anyway, so the only trace was a `log.warn` in the main process
 * (#790). The operator standing at the wall gets the URL and the reason
 * instead.
 */
export function BlockedLayerNotice({
  url,
  reason,
}: {
  url: string
  reason: string
}) {
  return (
    <NoticeBox role="alert">
      <strong>Blocked</strong> <NoticeURL>{url}</NoticeURL>
      <NoticeReason>{reason}</NoticeReason>
    </NoticeBox>
  )
}

const NoticeBox = styled.div`
  padding: 0.5em 0.75em;
  background: rgba(0, 0, 0, 0.75);
  border: 2px solid #d93f0b;
  border-radius: 4px;
  color: #fff;
  font-size: 14px;
  line-height: 1.4;
`

// Long operator-supplied URLs must wrap rather than push the box off the wall.
const NoticeURL = styled.span`
  word-break: break-all;
`

const NoticeReason = styled.div`
  opacity: 0.8;
`
