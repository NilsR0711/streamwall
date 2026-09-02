import type { StreamData } from './types.ts'

/**
 * The links the wall's two chrome layers are framing, as one comparable
 * string.
 *
 * A change to it is the operator's edit, and that is what takes a blocked-URL
 * notice down again — on the wall, where it remounts every layer frame so
 * anything still refused reports itself (#790), and in the broadcast state the
 * control UI reads (#797). Both sides derive it from this one function: if
 * they ever disagreed, the control UI's notice could be cleared without the
 * remount that would let a still-refused URL announce itself again, and the
 * refusal would be lost with no way back.
 *
 * A refused frame is requested exactly once, so a report can never expire on
 * its own evidence and a wall-clock timeout cannot tell "the operator fixed
 * it" from "the operator was not looking" — the edit is the only honest
 * signal, which is why this must not report one that did not happen. Hence
 * sorted (layer streams arrive from a polled data source, which is free to
 * return the same links in a different order) and JSON-encoded rather than
 * joined on a separator a link could itself contain.
 */
export function layerLinksKey(streams: readonly StreamData[]): string {
  const links = streams
    .filter((s) => s.kind === 'overlay' || s.kind === 'background')
    .map((s) => s.link)
  return JSON.stringify([...links].sort())
}
