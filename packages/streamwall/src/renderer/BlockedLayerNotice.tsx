import { styled } from 'styled-components'

/**
 * Names the URLs this layer's session refused to fetch.
 *
 * Without it the refusal is invisible: unlike a stream view a layer has no
 * `did-fail-load` surface, and a cancelled load inside an iframe would not
 * reach one anyway, so the only trace was a `log.warn` in the main process
 * (#790). The operator standing at the wall gets the addresses instead.
 *
 * The guard refuses a request for exactly one reason -- the address is not a
 * public one -- so the notice says that once rather than repeating the main
 * process's per-request wording, which already embeds the URL.
 */
export function BlockedLayerNotices({ urls }: { urls: readonly string[] }) {
  if (urls.length === 0) {
    return null
  }
  return (
    <NoticeBox role="alert">
      <strong>Blocked: not a public address</strong>
      {urls.map((url) => (
        <NoticeURL key={url}>{url}</NoticeURL>
      ))}
    </NoticeBox>
  )
}

const NoticeBox = styled.div`
  position: fixed;
  left: 1em;
  bottom: 1em;
  z-index: 1;
  max-width: 40vw;
  padding: 0.5em 0.75em;
  background: rgba(0, 0, 0, 0.75);
  border: 2px solid #d93f0b;
  border-radius: 4px;
  color: #fff;
  font-size: 14px;
  line-height: 1.4;
`

// Long operator-supplied URLs must wrap rather than push the box off the wall.
const NoticeURL = styled.div`
  word-break: break-all;
  opacity: 0.8;
`
