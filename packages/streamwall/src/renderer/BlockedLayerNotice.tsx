import { styled } from 'styled-components'

/**
 * How much of a refused URL is shown. A framed page can request an arbitrarily
 * long URL, and every refused one is reported, so an unbounded string would let
 * layer content wrap its way across the wall. The whole URL stays in the main
 * process log.
 */
export const MAX_SHOWN_URL_LENGTH = 120

function shorten(url: string): string {
  return url.length > MAX_SHOWN_URL_LENGTH
    ? `${url.slice(0, MAX_SHOWN_URL_LENGTH)}…`
    : url
}

/**
 * Names the URLs the wall's sessions refused to fetch.
 *
 * Without it the refusal is invisible: unlike a stream view a layer has no
 * `did-fail-load` surface, and a cancelled load inside an iframe would not
 * reach one anyway, so the only trace was a `log.warn` in the main process
 * (#790). The operator standing at the wall gets the addresses instead.
 *
 * The guard refuses a request for exactly one reason — the address is not a
 * public one — so the notice says that once rather than repeating the main
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
        <NoticeURL key={url}>{shorten(url)}</NoticeURL>
      ))}
    </NoticeBox>
  )
}

const NoticeBox = styled.div`
  position: fixed;
  left: 1em;
  bottom: 1em;
  z-index: 1;
  /* Bounded in both directions: the content is supplied by whatever the layer
     is framing, so it must never be able to take over the wall. */
  max-width: 40vw;
  max-height: 30vh;
  overflow: hidden;
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
