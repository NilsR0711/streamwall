// `navigator.clipboard.writeText` returns a promise that rejects (e.g. when
// clipboard permission is denied); a synchronous try/catch around the call
// does not observe that rejection, so it must be handled via `.catch`.
export function copyTextToClipboard(text: string): void {
  navigator.clipboard.writeText(text).catch((err: unknown) => {
    console.warn('Unable to copy stream id to clipboard:', err)
  })
}
