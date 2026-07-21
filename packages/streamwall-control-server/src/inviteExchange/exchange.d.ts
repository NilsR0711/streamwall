// Type contract for the browser-served `exchange.js`. It is authored as plain
// JS (so it can be served verbatim and executed by the browser), so this
// declaration types its testable entry point without pulling the DOM lib into
// the server's TypeScript program.

export interface InviteExchangeDeps {
  location: {
    hash: string
    pathname: string
    replace(url: string): void
  }
  history: {
    replaceState(data: unknown, unused: string, url: string): void
  }
  fetch: (
    url: string,
    init: {
      method: string
      headers: Record<string, string>
      body: string
    },
  ) => Promise<{ ok: boolean }>
  setStatus: (text: string) => void
}

/**
 * Reads the invite token from `location.hash`, scrubs it from the address bar,
 * and exchanges it for a session cookie via POST. Resolves once the attempt
 * settles.
 */
export function runInviteExchange(deps: InviteExchangeDeps): Promise<void>
